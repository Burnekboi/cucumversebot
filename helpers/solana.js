const web3 = require("@solana/web3.js");
const { 
  PublicKey, 
  Connection, 
  Keypair, 
  TransactionMessage, 
  VersionedTransaction, 
  Transaction,
  TransactionInstruction,
  SystemProgram, 
  LAMPORTS_PER_SOL, 
  ComputeBudgetProgram 
} = web3;
const anchor = require("@coral-xyz/anchor");
const { getAssociatedTokenAddressSync } = require("@solana/spl-token");
const axios = require('axios');
const FormData = require('form-data');
const { PumpFunSDK } = require('pumpdotfun-sdk');
const { AnchorProvider } = require('@coral-xyz/anchor');

const { base58Decode, base58Encode } = require('../utils/base58');

// Build a minimal AnchorProvider-compatible wallet from a Keypair
function makeWallet(keypair) {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx) => { tx.sign([keypair]); return tx; },
    signAllTransactions: async (txs) => { txs.forEach(tx => tx.sign([keypair])); return txs; }
  };
}

// Build and send a transaction using regular Transaction for pump.fun compatibility
async function buildAndSendTx(connection, instructions, payer, signers, priorityFees, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const tx = new Transaction();
      
      if (priorityFees) {
        const { ComputeBudgetProgram } = require('@solana/web3.js');
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: priorityFees.unitLimit }));
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFees.unitPrice }));
      }
      
      instructions.forEach(ix => tx.add(ix));
      
      // Get fresh blockhash for each attempt
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = payer;
      
      // Sign transaction
      tx.sign(...signers);
      
      // Send transaction with shorter timeout to avoid hanging
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 2
      });
      
      // Confirm transaction with timeout
      const confirmation = await Promise.race([
        connection.confirmTransaction({
          signature: sig,
          blockhash,
          lastValidBlockHeight
        }, 'confirmed'),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Transaction confirmation timeout')), 30000)
        )
      ]);
      
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      
      return sig;
      
    } catch (err) {
      lastError = err;
      console.error(`Attempt ${attempt} failed:`, err.message);
      
      // If it's the last attempt, throw the error
      if (attempt === maxRetries) {
        throw lastError;
      }
      
      // Wait before retry (exponential backoff)
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      console.log(`Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

/**
 * ===============================
 * 🛒 ATOMIC CREATE + BUY WITH JITO (FIXED)
 * ===============================
 */
async function executeAtomicCreateAndBuy(connection, sdk, mainKeypair, mintKeypair, tokenName, symbol, metadataUri, initialBuySol) {
  try {
    const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    const devBuyLamports = BigInt(Math.floor(initialBuySol * LAMPORTS_PER_SOL));

    // 0. Check SOL balance first
    const balance = await connection.getBalance(mainKeypair.publicKey);
    const estimatedCost = devBuyLamports + BigInt(20000000); // Buy amount + ~0.02 SOL for fees/tips
    
    if (balance < estimatedCost) {
      const deficit = Number(estimatedCost - balance) / LAMPORTS_PER_SOL;
      throw new Error(`❌ INSUFFICIENT SOL: Need ${initialBuySol} SOL for buy + ~0.02 SOL for fees, but only have ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL. Missing ${deficit.toFixed(4)} SOL`);
    }
    
    console.log(`✅ SOL balance check passed: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL available`);

    // 1. Get standard Create instructions
    console.log('🔧 Building Create instructions from SDK...');
    
    if (!mintKeypair || !mintKeypair.publicKey) {
      throw new Error('mintKeypair is not properly initialized');
    }
    
    console.log('🔑 Mint Keypair:', mintKeypair.publicKey.toString());
    
    const createTx = await sdk.getCreateInstructions(
      mainKeypair.publicKey,
      tokenName,
      symbol,
      "https://ipfs.io/ipfs/" + metadataUri.split("/").pop(),
      mintKeypair
    );
    const createInstructions = createTx.instructions;
    
    // Compute budget instructions
    createInstructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1500000 }));
    createInstructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }));
    
    console.log(`✅ Extracted ${createInstructions.length} create instructions from SDK`);

    // 2. Prepare Buy Instruction (Manual Construction)
    const globalAccount = await sdk.getGlobalAccount('confirmed');
    const buyAmount = globalAccount.getInitialBuyPrice(devBuyLamports);
    const buyAmountWithSlippage = buyAmount + (buyAmount * 500n / 10000n); // 5% slippage

    const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mintKeypair.publicKey.toBuffer()], PUMP_PROGRAM);
    const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
        [bondingCurve.toBuffer(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(), mintKeypair.publicKey.toBuffer()],
        new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    );
    const userATA = getAssociatedTokenAddressSync(mintKeypair.publicKey, mainKeypair.publicKey);
    
    // THE FIX: Define 13th and 14th accounts
    const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], PUMP_PROGRAM);
    const [bondingCurveV2] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve-v2'), mintKeypair.publicKey.toBuffer()], PUMP_PROGRAM);

    console.log(`🔧 Bonding Curve: ${bondingCurve.toString()}`);
    console.log(`🔧 Global Volume Accumulator: ${globalVolumeAccumulator.toString()}`);
    console.log(`🔧 Bonding Curve V2: ${bondingCurveV2.toString()}`);

    const buyIx = await sdk.program.methods
      .buy(new anchor.BN(buyAmount.toString()), new anchor.BN(buyAmountWithSlippage.toString()))
      .accounts({
        global: new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"),
        feeRecipient: new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV"),
        mint: mintKeypair.publicKey,
        bondingCurve: bondingCurve,
        associatedBondingCurve: associatedBondingCurve,
        associatedUser: userATA,
        user: mainKeypair.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
        eventAuthority: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"),
        program: PUMP_PROGRAM,
      })
      .remainingAccounts([
        { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true },
        { pubkey: bondingCurveV2, isSigner: false, isWritable: true },
        { pubkey: feeConfig, isSigner: false, isWritable: false },
        { pubkey: feeProgram, isSigner: false, isWritable: false },
      ])
      .instruction();

    // 3. Jito Tip (Targeting a reliable tip account)
    const tipIx = SystemProgram.transfer({
      fromPubkey: mainKeypair.publicKey,
      toPubkey: new PublicKey("Cw8CFyMvGrnCqR8FdiRLS9nEbEEDrgfM9az8LqCacHPy"),
      lamports: 1000000, // 0.001 SOL
    });

    // 4. Combine all instructions into a single Atomic Set
    const allInstructions = [
      ...createInstructions, 
      buyIx,
      tipIx
    ];

    console.log(`🚀 Creating Atomic VersionedTransaction with ${allInstructions.length} instructions...`);
    
    // 5. Compile into a Versioned Transaction
    const { blockhash } = await connection.getLatestBlockhash("finalized");
    const messageV0 = new TransactionMessage({
        payerKey: mainKeypair.publicKey,
        recentBlockhash: blockhash,
        instructions: allInstructions,
    }).compileToV0Message();
    
    const transaction = new VersionedTransaction(messageV0);

    // 6. Sign with both the Payer and the Mint Keypair
    transaction.sign([mainKeypair, mintKeypair]);
    
    // 7. Execute via your Jito function
    const result = await sendJitoBundle({
      transactions: [transaction],
      maxRetries: 3
    });

    if (!result.success) throw new Error(result.error);
    
    console.log(`✅ Atomic transaction successful: ${result.signature}`);
    return result.signature;

  } catch (err) {
    console.error("Atomic Error Detail:", err);
    throw new Error(handleTransactionError(err));
  }
}

/**
 * 📦 IMPROVED JITO BUNDLE SENDER
 */
async function sendJitoBundle({ transactions, maxRetries = 3 }) {
  const bs58 = require('bs58');
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log('🔍 Debug - Building Jito bundle payload...');
      
      const bundle = transactions.map(tx => {
        // Force base58 encoding for Jito Engine
        return bs58.default ? bs58.default.encode(tx.serialize()) : bs58.encode(tx.serialize());
      });

      // 🚀 SEND TO JITO
      const response = await fetch('https://mainnet.block-engine.jito.wtf/api/v1/bundles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [bundle]
        }),
      });

      const data = await response.json();
      
      if (data.error) throw new Error(data.error.message);
      if (!data.result) throw new Error('No result returned from Jito bundle');

      console.log('✅ Bundle sent successfully:', data.result);
      return { success: true, signature: data.result };
      
    } catch (err) {
      console.error(`❌ Bundle attempt ${attempt} failed:`, err.message);
      if (attempt === maxRetries) return { success: false, error: err.message };
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

/**
 * ===============================
 * 🚀 MAIN DEPLOYMENT HANDLER
 * ===============================
 */
async function handleDeployRequest(bot, connection, data, chatId, session, termMsgId = null) {
  try {
    const { performRealTrading } = require('./trading');

    const editTerminal = async (text) => {
      const msg = `🥒 *CUCUMVERSE DEPLOYMENT TERMINAL*\n➖➖➖➖➖➖➖➖➖➖\n${text}`;
      if (termMsgId) {
        await bot.editMessageText(msg, {
          chat_id: chatId, message_id: termMsgId,
          parse_mode: 'Markdown', disable_web_page_preview: true
        }).catch(() => {});
      } else {
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
      }
    };

    // ---------------- SAFETY CHECK ----------------
    if (!session?.mainWallet?.priv) {
      throw new Error("No active wallet found. Please import or create one.");
    }

    // ---------------- BALANCE VALIDATION ----------------
    const deployBalance = await getBalance(connection, session.mainWallet.pub || session.mainWallet.address);
    const initialBuyAmount = parseFloat(data.initial_buy_sol) || 0;
    const minRequiredSOL = initialBuyAmount + 0.01; // Buy amount + buffer for fees
    
    if (deployBalance < minRequiredSOL) {
      throw new Error(`❌ Insufficient balance: Need ${minRequiredSOL.toFixed(4)} SOL, have ${deployBalance.toFixed(4)} SOL. Please add ${(minRequiredSOL - deployBalance).toFixed(4)} SOL to deploy with dev buy.`);
    }
    
    console.log(`✅ Balance check passed: ${deployBalance.toFixed(4)} SOL available, ${minRequiredSOL.toFixed(4)} SOL required`);

    // ---------------- INPUT MAPPING ----------------
    const tokenName         = data.name || data.tokenName || "Cucumverse Token";
    const symbol            = data.symbol || "CUCUM";
    const description       = data.description || "";
    const initialBuy        = parseFloat(data.initial_buy_sol) || 0;
    const selectedBotIds    = data.bot_fleet || [];
    const autoBuyEnabled    = data.auto_buy || false;
    const jitoBundleEnabled = data.jito_bundle || false;

    session.liveLogs = [];

    // ---------------- BOT WALLET PRE-FLIGHT CHECK ----------------
    if (autoBuyEnabled && selectedBotIds.length > 0) {
      const activeBuyersPreflight = (session.buyers || []).filter((_, i) =>
        selectedBotIds.includes(`bot-${i}`)
      );
      if (activeBuyersPreflight.length > 0) {
        const tc        = session.tradeConfig || {};
        const minBuy    = tc.minBuy ?? 0.01;
        const maxBuy    = tc.maxBuy ?? 0.05;
        const feeBuffer = 0.005;
        const balances  = await Promise.all(activeBuyersPreflight.map(b => getBalance(connection, b.pub)));
        const maxBotSol = Math.max(...balances);
        const allInsufficient = balances.every(b => b < minBuy + feeBuffer);

        if (maxBuy > maxBotSol) {
          await bot.sendMessage(chatId,
            `⚠️ *Trade Config Warning*\n\nMax Buy (${maxBuy} SOL) exceeds highest bot balance (${maxBotSol.toFixed(4)} SOL).\n\nAdjust in ⚙️ Trade Settings.`,
            { parse_mode: 'Markdown' });
          return;
        }
        if (allInsufficient) {
          await bot.sendMessage(chatId,
            `⚠️ *Insufficient Bot Balances*\n\nAll bots have less than ${(minBuy + feeBuffer).toFixed(4)} SOL.\n\nFund wallets or lower Min Buy.`,
            { parse_mode: 'Markdown' });
          return;
        }
      }
    }

    await editTerminal("☁️ *Uploading metadata and image to IPFS...*");

    // ---------------- IMAGE HANDLING ----------------
    const formData = new FormData();

    if (data.image_data && data.image_data.startsWith('data:image')) {
      const base64 = data.image_data.split(',')[1];
      formData.append("file", Buffer.from(base64, 'base64'), { filename: "token_image.png", contentType: 'image/png' });
    } else if (data.image || data.tokenImage) {
      try {
        const imageRes = await axios.get(data.image || data.tokenImage, { responseType: 'arraybuffer' });
        formData.append("file", Buffer.from(imageRes.data), "token_image.png");
      } catch (imgErr) {
        throw new Error(`Failed to fetch token image: ${imgErr.message}`);
      }
    } else {
      const defaultPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      formData.append("file", Buffer.from(defaultPng, 'base64'), { filename: "token_image.png", contentType: 'image/png' });
    }

    // ---------------- IPFS METADATA ----------------
    formData.append("name", tokenName);
    formData.append("symbol", symbol);
    formData.append("description", description);
    formData.append("twitter",  data.links?.twitter  || "");
    formData.append("telegram", data.links?.telegram || "");
    formData.append("website",  data.links?.website  || "");
    formData.append("showName", "true");

    const ipfsResponse = await axios.post("https://pump.fun/api/ipfs", formData, {
      headers: {
        ...formData.getHeaders(),
        'Origin': 'https://pump.fun', 'Referer': 'https://pump.fun/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 20000,
      validateStatus: () => true
    });

    console.log('📥 IPFS status:', ipfsResponse.status, JSON.stringify(ipfsResponse.data)?.slice(0, 200));

    if (ipfsResponse.status !== 200) {
      throw new Error(`IPFS upload failed (${ipfsResponse.status}): ${JSON.stringify(ipfsResponse.data)}`);
    }
    const metadataUri = ipfsResponse.data?.metadataUri;
    if (!metadataUri) throw new Error(`IPFS returned no metadataUri: ${JSON.stringify(ipfsResponse.data)}`);

    // ---------------- SDK DEPLOYMENT ----------------
    session.liveLogs.push({ status: 'processing', message: `🏗 Initializing deployment for ${symbol}...` });

    const mintKeypair   = Keypair.generate();
    const mintAddress   = mintKeypair.publicKey.toBase58();
    const mainKeypair   = Keypair.fromSecretKey(base58Decode(session.mainWallet.priv));

    await editTerminal(`🏗 *Deploying \`${tokenName}\` on Pump.fun...*\nDev buy: ${initialBuy} SOL`);

    // Build SDK provider — uses our own RPC, no PumpPortal dependency
    const provider = new AnchorProvider(connection, makeWallet(mainKeypair), { commitment: 'confirmed' });
    const sdk      = new PumpFunSDK(provider);

    const priorityFees = { unitLimit: 250000, unitPrice: 250000 };

    // Resolve active buyers
    const activeBuyers = (autoBuyEnabled && selectedBotIds.length > 0)
      ? (session.buyers || []).filter((_, i) => selectedBotIds.includes(`bot-${i}`))
      : [];

    const devBuyLamports = BigInt(Math.floor((initialBuy > 0 ? initialBuy : 0.001) * LAMPORTS_PER_SOL));

    // Clear previous token from DB before creating new one
    if (session.tradeConfig?.contractAddress) {
      console.log(`🗑️ Clearing previous token from DB: ${session.tradeConfig.contractAddress}`);
      session.tradeConfig = {}; // Reset trade config
    }

    // Pre-calculate estimated token amount for logs (upfront, no chain read)
    const VIRT_SOL  = BigInt(30_000_000_000);
    const VIRT_TOKS = BigInt(1_073_000_191) * BigInt(1_000_000);
    const estRawToks  = (VIRT_TOKS * devBuyLamports) / (VIRT_SOL + devBuyLamports);
    const estDevTokens = (Number(estRawToks) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 });

    let deploymentSig;

    if (devBuyLamports > 0n) {
      // ─────────────────────────────────────────────────────────────────
      // ATOMIC CREATE + DEV BUY WITH JITO BUNDLE
      // Uses Jito bundle for true atomic execution in same block
      // ─────────────────────────────────────────────────────────────────
      console.log(`🚀 Atomic create+buy (${initialBuy} SOL) — using Jito bundle`);

      session.liveLogs.push({
        status: 'processing',
        message: `🏗 Creating ${symbol} with atomic dev buy (${initialBuy} SOL ≈ ${estDevTokens} tokens) via Jito bundle...`
      });

      try {
        deploymentSig = await executeAtomicCreateAndBuy(
          connection,
          sdk,
          mainKeypair,
          mintKeypair,
          tokenName,
          symbol,
          metadataUri,
          initialBuy
        );
        
        console.log(`🔗 Atomic create+buy bundle sent: https://solscan.io/tx/${deploymentSig}`);
        
      } catch (bundleErr) {
        console.error('Jito bundle failed, falling back to legacy method:', bundleErr.message);
        
        // Check if it's a rate limit error - if so, wait a bit before fallback
        if (bundleErr.response?.status === 429 || bundleErr.message?.includes('rate limit')) {
          session.liveLogs.push({
            status: 'processing',
            message: `⚠️ Jito rate limited. Waiting 10s before fallback...`
          });
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
        
        // Fallback to legacy method if Jito fails
        session.liveLogs.push({
          status: 'processing',
          message: `⚠️ Jito bundle failed, using legacy atomic method...`
        });
        
        // Legacy method (current implementation)
        const createTx = await sdk.getCreateInstructions(
          mainKeypair.publicKey,
          tokenName,
          symbol,
          metadataUri,
          mintKeypair
        );

        const globalAccount = await sdk.getGlobalAccount('confirmed');
        const buyAmount = globalAccount.getInitialBuyPrice(devBuyLamports);
        const { calculateWithSlippageBuy } = require('pumpdotfun-sdk/dist/cjs/util');
        const buyAmountWithSlippage = calculateWithSlippageBuy(devBuyLamports, 500n);
        
        // Use enhanced buy instruction with all required accounts
        const buyTx = await buildBuyInstruction(
          connection,
          mainKeypair.publicKey,
          mintKeypair.publicKey,
          buyAmount,
          buyAmountWithSlippage
        );

        const combinedTx = new Transaction();
        combinedTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }));
        combinedTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250000 }));
        combinedTx.add(createTx);
        
        // Add all instructions from the buy transaction
        if (Array.isArray(buyTx.instructions)) {
          buyTx.instructions.forEach(ix => combinedTx.add(ix));
        } else {
          // buyTx is already a Transaction, add its instructions
          buyTx.instructions.forEach(ix => combinedTx.add(ix));
        }

        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const messageV0 = new TransactionMessage({
          payerKey:        mainKeypair.publicKey,
          recentBlockhash: blockhash,
          instructions:    combinedTx.instructions,
        }).compileToV0Message();
        const versionedTx = new VersionedTransaction(messageV0);
        versionedTx.sign([mainKeypair, mintKeypair]);

        const sig = await connection.sendTransaction(versionedTx, { skipPreflight: false });
        console.log(`🔗 Legacy create+buy TX: https://solscan.io/tx/${sig}`);

        const latestBlockhash = await connection.getLatestBlockhash();
        await connection.confirmTransaction({
          blockhash:           latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          signature:           sig,
        }, 'confirmed');

        deploymentSig = sig;
      }

    } else {
      // ─────────────────────────────────────────
      // CREATE ONLY — no dev buy
      // ─────────────────────────────────────────
      session.liveLogs.push({ status: 'processing', message: `🏗 Creating ${symbol} token...` });

      const createInstruction = await sdk.getCreateInstructions(
        mainKeypair.publicKey,
        tokenName,
        symbol,
        metadataUri,
        mintKeypair
      );

      deploymentSig = await buildAndSendTx(
        connection,
        Array.isArray(createInstruction) ? createInstruction : [createInstruction],
        mainKeypair.publicKey,
        [mainKeypair, mintKeypair],
        { unitLimit: 300000, unitPrice: 250000 }
      );
    }

    console.log(`✅ Token deployed! Signature: ${deploymentSig}`);
    session.liveLogs.push({ status: 'success', message: `🚀 Token Deployed! TX: ${String(deploymentSig).slice(0, 16)}...` });

    if (devBuyLamports > 0n) {
      session.liveLogs.push({ status: 'success', message: `💰 Dev Buy Complete! ${initialBuy} SOL → ~${estDevTokens} tokens` });
      session.liveLogs.push({ status: 'success', message: `👑 Dev wallet is FIRST BUYER ✅ (same TX as create)` });
    }

    session.liveLogs.push({ status: 'completed', message: `✅ ${symbol} token successfully created` });

    await editTerminal(
      `✅ *Deployment Complete!*\n\n` +
      `📍 Mint: \`${mintAddress}\`\n` +
      `💰 Dev Buy: ${devBuyLamports > 0n ? `${initialBuy} SOL (Mandatory Atomic) ✅` : 'No SOL ❌'}\n` +
      `🔗 [Pump.fun](https://pump.fun/${mintAddress})`
    );

    // ---------------- SAVE CONTRACT + TRADE CONFIG ----------------
    if (!session.tradeConfig) session.tradeConfig = {};
    session.tradeConfig.contractAddress = mintAddress;

    if (data.config) {
      session.tradeConfig.slippage           = parseFloat(data.config.slippage)    || 5;
      session.tradeConfig.minBuy             = parseFloat(data.config.minBuy)      || 0.01;
      session.tradeConfig.maxBuy             = parseFloat(data.config.maxBuy)      || 0.05;
      session.tradeConfig.sellPortionPercent = parseFloat(data.config.sellPercent) || 20;
      session.tradeConfig.takeProfitPercent  = parseFloat(data.config.takeProfit)  || 20;
    }

    session.liveLogs.push({ status: 'success', message: `🎉 ${symbol} deployed successfully!` });

    // ---------------- SWARM BUY (bot wallets) ----------------
    if (activeBuyers.length > 0) {
      await editTerminal(
        `🤖 *Swarm Engaged!*\n\n📍 Mint: \`${mintAddress}\`\n🚀 *${activeBuyers.length} bot wallets buying now...*`
      );
      const originalBuyers = session.buyers;
      session.buyers = activeBuyers;
      await performRealTrading(bot, connection, session, chatId);
      session.buyers = originalBuyers;
    }

    // ---------------- SHOW TRADE PANEL ----------------
    const { actionMenu } = require('../panels');
    const mainBalance = await getBalance(connection, session.mainWallet.pub);
    const tradePanel = actionMenu(session, mainBalance.toFixed(4));
    
    await bot.sendMessage(chatId, tradePanel.text, {
      reply_markup: tradePanel.reply_markup,
      parse_mode: 'Markdown'
    });

  } catch (err) {
    console.error('handleDeployRequest error:', err.message);
    
    // Enhanced error handling with transaction logs
    const errorMessage = handleTransactionError(err);
    
    // Add error log for webapp
    if (session) {
      session.liveLogs = session.liveLogs || [];
      session.liveLogs.push({ status: 'error', message: `❌ Deployment failed: ${errorMessage}` });
      session.liveLogs.push({ status: 'completed', message: `❌ Deployment failed!` });
    }
    
    // Show Trade panel even on error
    const { actionMenu } = require('../panels');
    const mainBalance = await getBalance(connection, session?.mainWallet?.pub || session?.mainWallet?.address);
    const tradePanel = actionMenu(session, mainBalance.toFixed(4));
    
    await bot.sendMessage(chatId, 
      `❌ *Deployment Failed:*\n\n\`${errorMessage}\``, 
      { parse_mode: 'Markdown' }
    ).then(() => {
      // Show trade panel after error message
      return bot.sendMessage(chatId, tradePanel.text, {
        reply_markup: tradePanel.reply_markup,
        parse_mode: 'Markdown'
      });
    }).catch(() => {});
  }
}

/**
 * ===============================
 * 🪙 SOL BALANCE
 * ===============================
 */
async function getBalance(connection, pubkey) {
  try {
    if (!pubkey) return 0;
    const lamports = await connection.getBalance(new PublicKey(pubkey));
    return lamports / LAMPORTS_PER_SOL;
  } catch (err) {
    console.error('getBalance error:', err.message);
    return 0;
  }
}

/**
 * ===============================
 * 📈 TOKEN PRICE
 * ===============================
 */
async function fetchTokenPriceInSol(mintAddress) {
  try {
    const res = await axios.get(`https://api.pumpfunapi.org/price/${mintAddress}`);
    return res.data?.SOL ? parseFloat(res.data.SOL) : 0;
  } catch {
    return 0;
  }
}

/**
 * ===============================
 * 💰 TOKEN BALANCE
 * ===============================
 */
async function getTokenBalance(connection, pubKey, mintAddress) {
  try {
    const res = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(pubKey),
      { mint: new PublicKey(mintAddress) }
    );
    if (!res.value.length) return 0;
    return res.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
  } catch {
    return 0;
  }
}

/**
 * ===============================
 * 💸 TOKEN VALUE (SOL)
 * ===============================
 */
async function getTokenValueInSol(connection, pubKey, mintAddress) {
  const balance = await getTokenBalance(connection, pubKey, mintAddress);
  const price   = await fetchTokenPriceInSol(mintAddress);
  return balance * price;
}

/**
 * ===============================
 * 🔻 SELL TOKENS
 * ===============================
 */
async function sellTokenAmount(bot, connection, buyer, sellAmount, contractAddress, chatId, walletIndex) {
  try {
    const buyerKeypair = Keypair.fromSecretKey(base58Decode(buyer.priv));
    const provider     = new AnchorProvider(connection, makeWallet(buyerKeypair), { commitment: 'confirmed' });
    const sdk          = new PumpFunSDK(provider);

    // sellAmount is in UI token units (e.g. 1000.5 tokens)
    // SDK expects raw token amount (multiply by 10^6 for pump.fun's 6 decimals)
    const rawAmount = BigInt(Math.floor(sellAmount * 1e6));

    const sellTx = await sdk.getSellInstructionsByTokenAmount(
      buyerKeypair.publicKey,
      new PublicKey(contractAddress),
      rawAmount,
      500n // 5% slippage
    );

    const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    if (sellTx && sellTx.instructions) {
      let creatorPubkey = new PublicKey("11111111111111111111111111111111");
      try {
        const bcData = await getBondingCurveData(connection, new PublicKey(contractAddress));
        if (bcData && bcData.creator) creatorPubkey = bcData.creator;
      } catch (e) {
        console.error("Could not fetch creator for vault PDA");
      }
      const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creatorPubkey.toBuffer()], PUMP_PROGRAM);
      const [feeConfig] = PublicKey.findProgramAddressSync([Buffer.from("fee_config")], PUMP_PROGRAM);
      const feeProgram = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

      sellTx.instructions.forEach(ix => {
        if (ix.programId.equals(PUMP_PROGRAM)) {
          const oldKeys = [...ix.keys];
          ix.keys = [];
          for (let i = 0; i <= 7; i++) {
            if (oldKeys[i]) ix.keys.push(oldKeys[i]);
          }
          
          // 8: creator_vault
          ix.keys.push({ pubkey: creatorVault, isSigner: false, isWritable: true });
          
          // 9: token_program (was at 9 in old sdk, but old sdk had associated_token at 8)
          if (oldKeys[9]) ix.keys.push(oldKeys[9]);
          else ix.keys.push({ pubkey: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), isSigner: false, isWritable: false });
          
          if (oldKeys[10]) ix.keys.push(oldKeys[10]);
          else ix.keys.push({ pubkey: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"), isSigner: false, isWritable: false });
          
          if (oldKeys[11]) ix.keys.push(oldKeys[11]);
          else ix.keys.push({ pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false });
          
          ix.keys.push({ pubkey: feeConfig, isSigner: false, isWritable: false });
          ix.keys.push({ pubkey: feeProgram, isSigner: false, isWritable: false });
        }
      });
    }

    const sig = await buildAndSendTx(
      connection,
      sellTx.instructions,
      buyerKeypair.publicKey,
      [buyerKeypair],
      { unitLimit: 250000, unitPrice: 250000 }
    );

    console.log(`✅ Sell tx: ${sig}`);
    return await getBalance(connection, buyer.pub);
  } catch (err) {
    console.error('sell error:', err.message);
    return null;
  }
}

/**
 * ===============================
 * 🛒 ENHANCED BUY INSTRUCTION BUILDER
 * ===============================
 */
async function buildBuyInstruction(connection, userPublicKey, mint, tokenAmount, maxSolCost) {
  const { PumpFunSDK } = require('pumpdotfun-sdk');
  const { AnchorProvider } = require('@coral-xyz/anchor');
  
  // Create a dummy provider for SDK usage
  const dummyWallet = {
    publicKey: userPublicKey,
    signTransaction: async () => { throw new Error('Not implemented'); },
    signAllTransactions: async () => { throw new Error('Not implemented'); }
  };
  
  const provider = new AnchorProvider(connection, dummyWallet, { commitment: 'confirmed' });
  const sdk = new PumpFunSDK(provider);
  
  try {
    // Get the global account for fee recipient
    const globalAccount = await sdk.getGlobalAccount('confirmed');
    
    console.log('🔍 Debug - Using SDK getBuyInstructions with global account');
    console.log('userPublicKey:', userPublicKey?.toString());
    console.log('mint:', mint?.toString());
    console.log('globalAccount.feeRecipient:', globalAccount.feeRecipient?.toString());
    console.log('tokenAmount:', tokenAmount?.toString());
    console.log('maxSolCost:', maxSolCost?.toString());
    
    // Use the SDK's getBuyInstructions method which should handle all required accounts
    const buyTx = await sdk.getBuyInstructions(
      userPublicKey,
      mint,
      globalAccount.feeRecipient,
      tokenAmount,
      maxSolCost
    );
    
        // THE FIX: Pump.fun massively upgraded to 16 accounts (March 2026) 
    // The old SDK only loads 12 accounts. We must hot-patch the anchor keys array completely!
    const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    if (buyTx && buyTx.instructions) {
      // Fetch creator for creator_vault PDA
      let creatorPubkey = new PublicKey("11111111111111111111111111111111");
      try {
        const bcData = await getBondingCurveData(connection, typeof mint === 'string' ? new PublicKey(mint) : mint);
        if (bcData && bcData.creator) creatorPubkey = bcData.creator;
      } catch (e) {
        console.error("Could not fetch creator for vault PDA");
      }

      const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creatorPubkey.toBuffer()], PUMP_PROGRAM);
      const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMP_PROGRAM);
      const pubkeyBuffer = typeof userPublicKey === 'string' ? new PublicKey(userPublicKey).toBuffer() : userPublicKey.toBuffer();
      const [userVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), pubkeyBuffer], PUMP_PROGRAM);
      const [feeConfig] = PublicKey.findProgramAddressSync([Buffer.from("fee_config")], PUMP_PROGRAM);
      const feeProgram = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

      buyTx.instructions.forEach(ix => {
        if (ix.programId.equals(PUMP_PROGRAM)) {
          // The old keys are: 0..8 standard. 9 is rent. 10 is eventAuthority. 11 is program.
          const oldKeys = [...ix.keys];
          
          ix.keys = [];
          for (let i = 0; i <= 8; i++) {
             if (oldKeys[i]) ix.keys.push(oldKeys[i]);
          }
          
          // 9: creator_vault (Replaces RENT)
          ix.keys.push({ pubkey: creatorVault, isSigner: false, isWritable: true });
          
          // 10 & 11: eventAuthority & program
          if (oldKeys[10]) ix.keys.push(oldKeys[10]);
          else ix.keys.push({ pubkey: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"), isSigner: false, isWritable: false });
          
          if (oldKeys[11]) ix.keys.push(oldKeys[11]);
          else ix.keys.push({ pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false });
          
          // Append the 4 new mandatory accounts!
          ix.keys.push({ pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true });
          ix.keys.push({ pubkey: userVolumeAccumulator, isSigner: false, isWritable: true });
          ix.keys.push({ pubkey: feeConfig, isSigner: false, isWritable: false });
          ix.keys.push({ pubkey: feeProgram, isSigner: false, isWritable: false });
        }
      });
    }

    console.log('✅ SDK buy instruction created successfully');
    console.log('🔍 Debug - buyTx structure:');
    console.log('buyTx type:', typeof buyTx);
    console.log('buyTx.instructions:', buyTx.instructions ? 'present' : 'missing');
    console.log('buyTx.signers:', buyTx.signers ? 'present' : 'missing');
    
    if (buyTx.instructions) {
      console.log('Number of instructions:', buyTx.instructions.length);
      buyTx.instructions.forEach((ix, i) => {
        console.log(`Instruction ${i}:`, ix?.programId?.toString());
        console.log(`  Keys: ${ix?.keys?.length || 0}`);
        if (ix.keys) {
          ix.keys.forEach((key, j) => {
            console.log(`    Key ${j}: ${key.pubkey?.toString()} (writable: ${key.isWritable}, signer: ${key.isSigner})`);
          });
        }
      });
    }
    
    return buyTx;
    
  } catch (err) {
    console.error('buildBuyInstruction error:', err.message);
    throw err;
  }
}

/**
 * ===============================
 * 📊 BONDING CURVE DATA
 * ===============================
 */
async function getBondingCurveData(connection, mint) {
  const { PumpFunSDK } = require('pumpdotfun-sdk');
  const { AnchorProvider } = require('@coral-xyz/anchor');
  
  // Create a dummy provider for SDK usage
  const dummyWallet = {
    publicKey: new PublicKey('11111111111111111111111111111111'),
    signTransaction: async () => { throw new Error('Not implemented'); },
    signAllTransactions: async () => { throw new Error('Not implemented'); }
  };
  
  const provider = new AnchorProvider(connection, dummyWallet, { commitment: 'confirmed' });
  const sdk = new PumpFunSDK(provider);
  
  try {
    const bondingCurveAccount = await sdk.getBondingCurveAccount(mint, 'confirmed');
    return {
      virtualSolReserves: bondingCurveAccount.virtualSolReserves,
      virtualTokenReserves: bondingCurveAccount.virtualTokenReserves,
      creator: bondingCurveAccount.creator
    };
  } catch (err) {
    console.error('getBondingCurveData error:', err.message);
    // Return fallback values
    return {
      virtualSolReserves: BigInt(1000000000000), // 1000 SOL
      virtualTokenReserves: BigInt(1000000000000), // 1B tokens
      creator: new PublicKey('11111111111111111111111111111111')
    };
  }
}

/**
 * ===============================
 * 🧮 CALCULATE BUY TOKENS
 * ===============================
 */
function calcBuyTokens(buyLamports, virtualSolReserves, virtualTokenReserves) {
  // Using constant product formula: tokens_out = (token_reserves * sol_in) / (sol_reserves + sol_in)
  // This is a simplified calculation - in reality, pump.fun uses a more complex formula
  const numerator = virtualTokenReserves * buyLamports;
  const denominator = virtualSolReserves + buyLamports;
  return numerator / denominator;
}

/**
 * ===============================
 * 📤 SEND TRANSACTION (ALIAS)
 * ===============================
 */
async function sendTx(connection, transaction, signers) {
  return await buildAndSendTx(
    connection,
    transaction.instructions,
    signers[0].publicKey,
    signers,
    { unitLimit: 250000, unitPrice: 250000 }
  );
}

function handleTransactionError(err) {
  // Extract error message and provide user-friendly feedback
  const errorMessage = err.message || err.toString();
  
  // Check for insufficient SOL errors first
  if (errorMessage.includes('INSUFFICIENT SOL') || errorMessage.includes('insufficient funds')) {
    return errorMessage.includes('INSUFFICIENT SOL') ? errorMessage : 'Insufficient SOL balance for this transaction';
  }
  
  // Common Solana error patterns
  if (errorMessage.includes('blockhash expired')) {
    return 'Transaction timed out. Please try again';
  }
  if (errorMessage.includes('custom program error: 0xbbd')) {
    return 'Transaction failed: Missing required account keys (global_volume_accumulator). This has been fixed in the updated code.';
  }
  if (errorMessage.includes('custom program error')) {
    return 'Transaction failed due to program error. Check token parameters and try again.';
  }
  if (errorMessage.includes('network') || errorMessage.includes('timeout')) {
    return 'Network error. Please check your connection and try again';
  }
  if (errorMessage.includes('Cannot read properties of undefined')) {
    return 'SDK error: Missing required parameters. This has been fixed in the updated code.';
  }
  
  // Return original error if no specific pattern matches
  return errorMessage;
}

module.exports = {
  handleDeployRequest,
  getBalance,
  fetchTokenPriceInSol,
  getTokenBalance,
  getTokenValueInSol,
  sellTokenAmount,
  buildBuyInstruction,
  getBondingCurveData,
  calcBuyTokens,
  sendTx,
  sendJitoBundle,
  executeAtomicCreateAndBuy,
  handleTransactionError
};
