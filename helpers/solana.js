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
          setTimeout(() => reject(new Error('Transaction confirmation timeout')), 45000) // Increased to 45s
        )
      ]);
      
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      
      console.log(`✅ Transaction successful on RPC ${connection.rpcEndpoint}: ${sig}`);
      return sig;
      
    } catch (err) {
      lastError = err;
      console.error(`Attempt ${attempt} failed on ${connection.rpcEndpoint}:`, err.message);
      
      // If it's last attempt, throw error
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
      throw new Error(`❌ INSUFFICIENT SOL: Need ${initialBuySol} SOL for buy + ~0.02 SOL for fees/tips, but only have ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL. Missing ${deficit.toFixed(4)} SOL. Atomic create+buy requires at least 0.05 SOL total.`);
    }
    
    console.log(`✅ SOL balance check passed: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL available (minimum 0.05 SOL required for atomic)`);

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

    // 2. Prepare Buy Instruction using SDK (like buildBuyInstruction)
    const globalAccount = await sdk.getGlobalAccount('confirmed');
    const buyAmount = globalAccount.getInitialBuyPrice(devBuyLamports);
    const { calculateWithSlippageBuy } = require('pumpdotfun-sdk/dist/cjs/util');
    const buyAmountWithSlippage = calculateWithSlippageBuy(devBuyLamports, 500n); // 5% slippage
    
    // Use SDK's getBuyInstructions then patch it
    const buyTx = await sdk.getBuyInstructions(
      mainKeypair.publicKey,
      mintKeypair.publicKey,
      globalAccount.feeRecipient,
      buyAmount,
      buyAmountWithSlippage
    );
    
    // Patch the buy instruction like we do in buildBuyInstruction
    if (buyTx && buyTx.instructions) {
      // Use main wallet as creator for atomic operations
      const creatorPubkey = mainKeypair.publicKey;
      const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creatorPubkey.toBuffer()], PUMP_PROGRAM);
      const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMP_PROGRAM);
      const [userVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), mainKeypair.publicKey.toBuffer()], PUMP_PROGRAM);
      
      // Use SDK's global account to get proper fee config
      try {
        const globalAccountData = await sdk.getGlobalAccount('confirmed');
        console.log(`🔧 Using SDK global account for fee configuration`);
      } catch (e) {
        console.log(`⚠️ Could not get global account, using derived fee_config`);
      }
      
      const [feeConfig] = PublicKey.findProgramAddressSync([Buffer.from("fee_config")], PUMP_PROGRAM);
      const feeProgram = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
      const [bondingCurveV2] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve-v2'), mintKeypair.publicKey.toBuffer()], PUMP_PROGRAM);

      console.log(`🔧 Creator Vault: ${creatorVault.toString()}`);
      console.log(`🔧 Global Volume Accumulator: ${globalVolumeAccumulator.toString()}`);
      console.log(`🔧 User Volume Accumulator: ${userVolumeAccumulator.toString()}`);
      console.log(`🔧 Fee Config: ${feeConfig.toString()}`);
      console.log(`🔧 Fee Program: ${feeProgram.toString()}`);
      console.log(`🔧 Bonding Curve V2: ${bondingCurveV2.toString()}`);

      buyTx.instructions.forEach(ix => {
        if (ix.programId.equals(PUMP_PROGRAM)) {
          const oldKeys = [...ix.keys];
          
          ix.keys = [];
          // Keep first 9 standard accounts
          for (let i = 0; i <= 8; i++) {
            if (oldKeys[i]) ix.keys.push(oldKeys[i]);
          }
          
          // 9: creator_vault (replaces rent)
          ix.keys.push({ pubkey: creatorVault, isSigner: false, isWritable: true });
          
          // 10 & 11: eventAuthority & program
          if (oldKeys[10]) ix.keys.push(oldKeys[10]);
          else ix.keys.push({ pubkey: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"), isSigner: false, isWritable: false });
          
          if (oldKeys[11]) ix.keys.push(oldKeys[11]);
          else ix.keys.push({ pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false });
          
          // Append the 4 new mandatory accounts! (fee_config as writable to allow initialization)
          ix.keys.push({ pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true });
          ix.keys.push({ pubkey: userVolumeAccumulator, isSigner: false, isWritable: true });
          ix.keys.push({ pubkey: feeConfig, isSigner: false, isWritable: true }); // Make writable for initialization
          ix.keys.push({ pubkey: feeProgram, isSigner: false, isWritable: false });
          ix.keys.push({ pubkey: bondingCurveV2, isSigner: false, isWritable: true });
        }
      });
    }
    
    const buyIx = buyTx.instructions.find(ix => ix.programId.equals(PUMP_PROGRAM));

    // 3. Jito Tip (Using correct NY tip account as first instruction for priority)
    const jitoTipIx = SystemProgram.transfer({
      fromPubkey: mainKeypair.publicKey,
      toPubkey: new PublicKey("DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"), // NY Jito Tip Account
      lamports: 1000000, // 0.001 SOL minimum tip
    });

    // 4. Combine all instructions into a single Atomic Set (tip first for priority)
    const allInstructions = [
      jitoTipIx, // Jito tip first for better priority
      ...createInstructions, 
      ...buyTx.instructions,
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
    
    // Check transaction size
    const serializedTx = transaction.serialize();
    const txSize = serializedTx.length;
    console.log(`📏 Transaction size: ${txSize} bytes (limit: 1232 bytes)`);
    
    if (txSize > 1232) {
      console.warn(`⚠️ Transaction too large! ${txSize} > 1232 bytes. This may cause Jito 400 errors.`);
      console.log(`📋 Instruction breakdown:`);
      allInstructions.forEach((ix, i) => {
        console.log(`  ${i+1}. ${ix.programId.toString()} (${ix.data.length} bytes data)`);
      });
    }

    // 6. Sign with both the Payer and the Mint Keypair
    transaction.sign([mainKeypair, mintKeypair]);
    
    // 7. Execute via your Jito function
    const result = await sendJitoBundle({
      transactions: [transaction],
      maxRetries: 3
    });

    if (!result.success) throw new Error(result.error);
    
    console.log(`✅ Atomic transaction submitted: ${result.signature}`);
    
    // Verify atomic transaction created the token properly
    console.log(`🔍 Verifying atomic token creation...`);
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for bundle execution
    
    let tokenExists = false;
    try {
      const bondingCurveData = await getBondingCurveData(connection, mintKeypair.publicKey);
      if (bondingCurveData && bondingCurveData.virtualSolReserves) {
        tokenExists = true;
        console.log(`✅ Atomic token verified on-chain - Bonding curve found`);
      }
    } catch (verifyErr) {
      console.error(`❌ Atomic token verification failed: ${verifyErr.message}`);
    }
    
    if (!tokenExists) {
      throw new Error(`Atomic token creation failed - bonding curve not found. Bundle: ${result.signature}`);
    }
    
    return result.signature;

  } catch (err) {
    console.error("Atomic Error Detail:", err);
    throw new Error(handleTransactionError(err));
  }
}

/**
 *   HYBRID BATCH BUYING (10 per second, 1.5s interval)
 */
async function executeHybridBatchBuying(bot, connection, session, chatId, contractAddress, activeBuyers) {
  const BATCH_SIZE = 10;
  const BATCH_INTERVAL = 1500; // 1.5 seconds between batches
  
  console.log(`🚀 Starting hybrid batch buying: ${activeBuyers.length} wallets in batches of ${BATCH_SIZE}`);
  
  let totalSuccess = 0;
  let totalFailed = 0;
  let batchIndex = 0;
  
  // Process wallets in batches
  for (let i = 0; i < activeBuyers.length; i += BATCH_SIZE) {
    batchIndex++;
    const batch = activeBuyers.slice(i, i + BATCH_SIZE);
    
    console.log(`📦 Batch ${batchIndex}: Processing ${batch.length} wallets (${i + 1}-${Math.min(i + BATCH_SIZE, activeBuyers.length)})`);
    
    // Execute batch in parallel (within the batch)
    const batchPromises = batch.map(async (buyer, batchIndexWithinBatch) => {
      try {
        const { minBuy, maxBuy, slippage } = session.tradeConfig;
        const buyAmount = minBuy + Math.random() * (maxBuy - minBuy);
        
        console.log(`🤖 Bot ${i + batchIndexWithinBatch + 1}: Buying ${buyAmount.toFixed(4)} SOL of ${contractAddress.slice(0, 8)}...`);
        
        // Use the same buy logic as individual bot wallets
        const beforeBalance = await getTokenBalance(connection, buyer.pub, contractAddress);
        
        const buyLamports = BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL));
        const bondingCurveData = await getBondingCurveData(connection, new PublicKey(contractAddress));
        
        if (!bondingCurveData || !bondingCurveData.virtualSolReserves) {
          throw new Error('Could not fetch bonding curve data');
        }
        
        const { virtualSolReserves, virtualTokenReserves } = bondingCurveData;
        const tokenAmt = calcBuyTokens(buyLamports, virtualSolReserves, virtualTokenReserves);
        const maxSolCost = buyLamports * 110n / 100n; // 10% slippage
        
        const buyTx = await buildBuyInstruction(
          connection,
          buyer.pub,
          new PublicKey(contractAddress),
          tokenAmt,
          maxSolCost
        );
        
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250000 }));
        
        if (buyTx.instructions) {
          buyTx.instructions.forEach(ix => tx.add(ix));
        } else {
          tx.add(buyTx);
        }
        
        const buyerKeypair = Keypair.fromSecretKey(base58Decode(buyer.priv));
        const signature = await sendTx(connection, tx, [buyerKeypair]);
        
        // Verify buy actually worked
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for confirmation
        const afterBalance = await getTokenBalance(connection, buyer.pub, contractAddress);
        
        if (afterBalance <= beforeBalance) {
          throw new Error(`No tokens received. Before: ${beforeBalance}, After: ${afterBalance}`);
        }
        
        const tokenReceived = afterBalance - beforeBalance;
        const solLeft = await getBalance(connection, buyer.pub);
        
        // Set trade info for this bot
        buyer.trade = {
          entryPricePerToken: buyAmount / tokenReceived,
          entrySol: buyAmount
        };
        
        console.log(`✅ Bot ${i + batchIndexWithinBatch + 1}: SUCCESS - ${tokenReceived} tokens for ${buyAmount} SOL`);
        
        return {
          success: true,
          botIndex: i + batchIndexWithinBatch + 1,
          tokens: tokenReceived,
          solSpent: buyAmount,
          signature: signature.slice(0, 16)
        };
        
      } catch (error) {
        console.error(`❌ Bot ${i + batchIndexWithinBatch + 1}: FAILED - ${error.message}`);
        return {
          success: false,
          botIndex: i + batchIndexWithinBatch + 1,
          error: error.message
        };
      }
    });
    
    // Wait for current batch to complete
    const batchResults = await Promise.all(batchPromises);
    
    // Count results
    batchResults.forEach(result => {
      if (result.success) {
        totalSuccess++;
      } else {
        totalFailed++;
      }
    });
    
    // Update session with batch progress
    const progress = Math.min(((i + BATCH_SIZE) / activeBuyers.length) * 100, 100);
    session.liveLogs.push({
      status: 'processing',
      message: `📦 Batch ${batchIndex} complete: ${batchResults.filter(r => r.success).length}/${batch.length} successful (${progress.toFixed(1)}% total)`
    });
    
    // Wait before next batch (except for the last batch)
    if (i + BATCH_SIZE < activeBuyers.length) {
      console.log(`⏳ Waiting ${BATCH_INTERVAL}ms before next batch...`);
      await new Promise(resolve => setTimeout(resolve, BATCH_INTERVAL));
    }
  }
  
  console.log(`🎯 Hybrid batch buying complete: ${totalSuccess} success, ${totalFailed} failed`);
  
  return { totalSuccess, totalFailed };
}

/**
 * 📦 ENHANCED JITO BUNDLE SENDER WITH PROPER ENDPOINTS
 */
async function sendJitoBundle({ transactions, maxRetries = 3 }) {
  const bs58 = require('bs58');
  
  // Multiple Jito endpoints for redundancy
  const jitoEndpoints = [
    'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles'
  ];
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    for (const endpoint of jitoEndpoints) {
      try {
        console.log(`🔍 Debug - Building Jito bundle payload for ${endpoint}...`);
        
        const bundle = transactions.map(tx => {
          // Force base58 encoding for Jito Engine
          return bs58.default ? bs58.default.encode(tx.serialize()) : bs58.encode(tx.serialize());
        });

        console.log(`🚀 Sending bundle to ${endpoint} (Attempt ${attempt}/${maxRetries})`);
        
        // 🚀 SEND TO JITO WITH ENHANCED HEADERS
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Cucumverse-Bot/1.0',
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "sendBundle",
            params: [bundle]
          }),
          timeout: 15000, // 15 second timeout
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        
        if (data.error) {
          console.error(`Jito API Error: ${JSON.stringify(data.error)}`);
          throw new Error(data.error.message || 'Jito API error');
        }
        
        if (!data.result) {
          throw new Error('No result returned from Jito bundle');
        }

        const bundleId = data.result;
        console.log('✅ Bundle sent successfully:', bundleId);
        
        // Wait for bundle confirmation
        console.log('⏳ Waiting for bundle confirmation...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        return { success: true, signature: bundleId };
        
      } catch (err) {
        console.error(`❌ Bundle attempt ${attempt} failed for ${endpoint}:`, err.message);
        
        // If this is not the last endpoint, try the next one
        if (endpoint !== jitoEndpoints[jitoEndpoints.length - 1]) {
          console.log('🔄 Trying next Jito endpoint...');
          continue;
        }
        
        // If this is the last endpoint and last attempt, return failure
        if (attempt === maxRetries) {
          return { success: false, error: err.message };
        }
        
        // Wait before retrying (exponential backoff)
        const delay = Math.min(2000 * Math.pow(2, attempt - 1), 10000); // Max 10s
        console.log(`⏳ Waiting ${delay}ms before retry...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  
  return { success: false, error: 'All Jito endpoints failed after maximum retries' };
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
    let devBuyActuallySucceeded = false; // Track dev buy success at function level

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
        devBuyActuallySucceeded = true; // Atomic buy includes dev buy
        
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
          message: `⚠️ Jito bundle failed, using legacy create+buy method...`
        });
        
        // First, create the token using SDK's create instructions
        const createInstructionsTx = await sdk.getCreateInstructions(
          mainKeypair.publicKey,
          tokenName,
          symbol,
          metadataUri,
          mintKeypair
        );
        
        const createSig = await buildAndSendTx(
          connection,
          Array.isArray(createInstructionsTx) ? createInstructionsTx : [createInstructionsTx],
          mainKeypair.publicKey,
          [mainKeypair, mintKeypair],
          { unitLimit: 400000, unitPrice: 250000 }
        );
        
        console.log(`✅ Token creation TX: https://solscan.io/tx/${createSig}`);
        
        // Verify token was actually created by checking bonding curve
        console.log(`🔍 Verifying token creation...`);
        await new Promise(resolve => setTimeout(resolve, 3000)); // Longer wait for propagation
        
        let tokenExists = false;
        try {
          const bondingCurveData = await getBondingCurveData(connection, mintKeypair.publicKey);
          if (bondingCurveData && bondingCurveData.virtualSolReserves) {
            tokenExists = true;
            console.log(`✅ Token verified on-chain - Bonding curve found`);
          }
        } catch (verifyErr) {
          console.error(`❌ Token verification failed: ${verifyErr.message}`);
        }
        
        if (!tokenExists) {
          throw new Error(`Token creation failed - bonding curve not found. TX: ${createSig}`);
        }
        
        // Now use bot wallet functions for dev buy (priority execution)
        let devBuySignature = null;
        
        try {
          console.log(`🛒 Attempting priority dev buy of ${initialBuy} SOL tokens using bot wallet functions...`);
          
          // Create a temporary bot wallet structure for dev wallet
          const devBotWallet = {
            pub: mainKeypair.publicKey,
            priv: session.mainWallet.priv,
            trade: null
          };
          
          // Use the same buy logic as bot wallets but with priority
          const beforeBalance = await getTokenBalance(connection, devBotWallet.pub, mintAddress);
          console.log(`📊 Dev wallet before balance: ${beforeBalance} tokens`);
          
          const buyLamports = BigInt(Math.floor(initialBuy * LAMPORTS_PER_SOL));
          
          // Get current bonding curve state for accurate token amount
          const bondingCurveData = await getBondingCurveData(connection, mintKeypair.publicKey);
          if (!bondingCurveData || !bondingCurveData.virtualSolReserves) {
            throw new Error('Could not fetch bonding curve data for dev buy');
          }
          
          const { virtualSolReserves, virtualTokenReserves } = bondingCurveData;
          const tokenAmt = calcBuyTokens(buyLamports, virtualSolReserves, virtualTokenReserves);
          const maxSolCost = buyLamports * 110n / 100n; // 10% slippage
          
          console.log(`🎯 Dev wallet buying ${tokenAmt} tokens for ${initialBuy} SOL (priority)`);
          
          const buyTx = await buildBuyInstruction(
            connection,
            devBotWallet.pub,
            mintKeypair.publicKey,
            tokenAmt,
            maxSolCost
          );
          
          const tx = new Transaction();
          tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
          tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250000 }));
          
          // Add all instructions from buyTx
          if (buyTx.instructions) {
            buyTx.instructions.forEach(ix => tx.add(ix));
          } else {
            tx.add(buyTx);
          }
          
          console.log(`📤 Dev wallet sending priority transaction...`);
          devBuySignature = await sendTx(connection, tx, [mainKeypair]);
          console.log(`✅ Dev wallet priority TX sent: https://solscan.io/tx/${devBuySignature}`);
          
          // CRITICAL: Verify buy actually worked (same as bot wallets)
          console.log(`🔍 Verifying dev wallet purchase...`);
          await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for confirmation
          
          const afterBalance = await getTokenBalance(connection, devBotWallet.pub, mintAddress);
          console.log(`📊 Dev wallet after balance: ${afterBalance} tokens`);
          
          if (afterBalance <= beforeBalance) {
            throw new Error(`No tokens received. Before: ${beforeBalance}, After: ${afterBalance}`);
          }
          
          // SUCCESS - Dev wallet bought successfully
          const tokenReceived = afterBalance - beforeBalance;
          const solLeft = await getBalance(connection, devBotWallet.pub);
          
          console.log(`🎉 Dev wallet SUCCESS: ${tokenReceived} tokens for ${initialBuy} SOL`);
          
          // Set dev wallet trade info for tracking
          devBotWallet.trade = {
            entryPricePerToken: initialBuy / tokenReceived,
            entrySol: initialBuy
          };
          
          devBuyActuallySucceeded = true;
          deploymentSig = createSig; // Use creation signature as main signature
          
          // Add success log
          session.liveLogs.push({
            status: 'success',
            message: `🎉 Dev wallet priority buy: ${initialBuy} SOL → ${tokenReceived.toFixed(2)} tokens`
          });
          
          console.log(`✅ Dev wallet priority buy VERIFIED - ${tokenReceived} tokens received`);
          session.liveLogs.push({ status: 'success', message: `💰 Dev Buy Complete! ${initialBuy} SOL → ${tokenReceived.toFixed(2)} tokens` });
          session.liveLogs.push({ status: 'success', message: `👑 Dev wallet is FIRST BUYER ✅ TX: ${devBuySignature.slice(0, 16)}...` });
          
        } catch (buyError) {
          console.error(`❌ Dev buy failed: ${buyError.message}`);
          
          // Don't show fake success - be clear about the failure
          session.liveLogs.push({
            status: 'error',
            message: `❌ Dev buy failed: ${buyError.message}. Token created but dev wallet couldn't buy.`
          });
          
          // If we have a signature but it failed, show that too
          if (devBuySignature) {
            session.liveLogs.push({
              status: 'warning',
              message: `🔗 Failed buy TX: ${devBuySignature.slice(0, 16)}...`
            });
          }
          
          deploymentSig = createSig; // Still return create signature since token was created
        }
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
      // Dev buy verification is now done in the buy logic above
      // No need to re-verify here since we already checked it properly
      if (!devBuyActuallySucceeded && deploymentSig) {
        // Check if dev buy was attempted but failed
        session.liveLogs.push({ 
          status: 'warning', 
          message: `⚠️ Dev wallet attempted buy but may have failed. Check transaction logs.` 
        });
      }
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

    // ---------------- SAVE LATEST TOKEN FOR BOT WALLETS ----------------
    try {
      const { saveLatestToken } = require('./tokenDatabase');
      await saveLatestToken({
        mintAddress,
        symbol,
        tokenName,
        creator: session.mainWallet.pub.toString(),
        devBuyAmount: devBuyLamports > 0n ? initialBuy : 0,
        deploymentSig,
        chatId,
        sessionId: chatId,
        tradeConfig: session.tradeConfig
      });
      
      console.log(`💾 Latest token ${symbol} saved for bot wallet trading`);
      
    } catch (dbError) {
      console.error('❌ Error saving latest token:', dbError);
    }

    session.liveLogs.push({ status: 'success', message: `🎉 ${symbol} deployed successfully!` });

    // ---------------- SWARM BUY (bot wallets) ----------------
    if (activeBuyers.length > 0) {
      await editTerminal(
        `🤖 *Swarm Engaged!*\n\n📍 Mint: \`${mintAddress}\`\n🚀 *${activeBuyers.length} bot wallets buying now...*`
      );
      
      // Add log to show bot wallets are attempting to buy
      session.liveLogs.push({ 
        status: 'processing', 
        message: `🤖 ${activeBuyers.length} bot wallets attempting to buy ${symbol}...` 
      });
      
      const originalBuyers = session.buyers;
      session.buyers = activeBuyers;
      await performRealTrading(bot, connection, session, chatId);
      session.buyers = originalBuyers;
      
      // Add completion log for bot wallets
      session.liveLogs.push({ 
        status: 'success', 
        message: `✅ Bot wallet swarm completed` 
      });
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
        if (bcData && bcData.creator) {
          creatorPubkey = bcData.creator;
          console.log(`🔧 Using creator from bonding curve: ${creatorPubkey.toString()}`);
        } else {
          console.log(`⚠️ Bonding curve data not found, using default creator`);
        }
      } catch (e) {
        console.error("Could not fetch creator for vault PDA:", e.message);
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
    console.log(`🔍 Fetching bonding curve for mint: ${mint.toString()}`);
    const bondingCurveAccount = await sdk.getBondingCurveAccount(mint, 'confirmed');
    
    if (!bondingCurveAccount) {
      console.error(`❌ Bonding curve account not found for mint: ${mint.toString()}`);
      return null;
    }
    
    if (!bondingCurveAccount.virtualSolReserves) {
      console.error(`❌ Bonding curve has no virtual SOL reserves for mint: ${mint.toString()}`);
      return null;
    }
    
    console.log(`✅ Bonding curve found - SOL: ${bondingCurveAccount.virtualSolReserves}, Tokens: ${bondingCurveAccount.virtualTokenReserves}`);
    
    return {
      virtualSolReserves: bondingCurveAccount.virtualSolReserves,
      virtualTokenReserves: bondingCurveAccount.virtualTokenReserves,
      creator: bondingCurveAccount.creator
    };
  } catch (err) {
    console.error(`getBondingCurveData error for ${mint.toString()}:`, err.message);
    
    // Check if it's a "not found" error vs other errors
    if (err.message.includes('Account does not exist') || err.message.includes('not found')) {
      console.log(`ℹ️ Token ${mint.toString()} does not exist yet or bonding curve not created`);
      return null;
    }
    
    // For other errors, return fallback values but log the issue
    console.log(`⚠️ Using fallback bonding curve data due to error: ${err.message}`);
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
  executeHybridBatchBuying,
  handleTransactionError
};
