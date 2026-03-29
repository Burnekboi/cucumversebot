const axios = require('axios');
const FormData = require('form-data');
const { PumpFunSDK } = require('pumpdotfun-sdk');
const { AnchorProvider } = require('@coral-xyz/anchor');

const {
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  Keypair,
  Connection
} = require('@solana/web3.js');

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

    // Create token and atomic dev buy if needed
    let createTx;
    
    if (devBuyLamports > 0n) {
      // MANDATORY: Dev buy must be bundled with token creation using Jito
      console.log(`🚀 Creating token with MANDATORY atomic dev buy (${initialBuy} SOL)`);
      
      // Get create instructions
      const createInstructions = await sdk.getCreateInstructions(
        mainKeypair.publicKey,
        tokenName,
        symbol,
        metadataUri,
        mintKeypair
      );

      // Get dev buy instructions (MUST be included)
      const globalAccount = await sdk.getGlobalAccount('confirmed');
      const buyAmount = globalAccount.getInitialBuyPrice(devBuyLamports);
      const { calculateWithSlippageBuy } = require('pumpdotfun-sdk/dist/cjs/util');
      const buyAmountWithSlippage = calculateWithSlippageBuy(devBuyLamports, 500n);
      
      const buyInstructions = await sdk.getBuyInstructions(
        mainKeypair.publicKey,
        mintKeypair.publicKey,
        globalAccount.feeRecipient,
        buyAmount,
        buyAmountWithSlippage
      );

      // Combine both instructions for MANDATORY atomic execution
      const combinedInstructions = [createInstructions, buyInstructions];
      createTx = combinedInstructions;
      
      session.liveLogs.push({ status: 'processing', message: `🏗 Creating ${symbol} with MANDATORY atomic dev buy (${initialBuy} SOL)...` });
    } else {
      // Create token only (no dev buy - no Jito needed)
      createTx = await sdk.getCreateInstructions(
        mainKeypair.publicKey,
        tokenName,
        symbol,
        metadataUri,
        mintKeypair
      );
      
      session.liveLogs.push({ status: 'processing', message: `🏗 Creating ${symbol} token...` });
    }

    console.log(`🚀 Sending deployment tx | mint: ${mintAddress} | atomic dev buy: ${devBuyLamports > 0n ? 'MANDATORY' : 'NO'}`);

    const deploymentSig = await buildAndSendTx(
      connection,
      Array.isArray(createTx) ? createTx.flatMap(tx => tx.instructions || tx) : [createTx],
      mainKeypair.publicKey,
      [mainKeypair, mintKeypair],
      priorityFees
    );

    console.log(`✅ Token deployed! Signature: ${deploymentSig}`);
    session.liveLogs.push({ status: 'success', message: `🚀 Token Deployed! TX: ${deploymentSig.slice(0, 16)}...` });

    // If dev buy was included atomically, show success
    if (devBuyLamports > 0n) {
      // Calculate dev's token holdings
      const globalAccount = await sdk.getGlobalAccount('confirmed');
      const devTokens = Number(globalAccount.getInitialBuyPrice(devBuyLamports)) / 1e6;
      
      session.liveLogs.push({ status: 'success', message: `💰 Atomic Dev Buy Completed! (${initialBuy} SOL)` });
      session.liveLogs.push({ status: 'success', message: `👤 Dev secured ${devTokens.toFixed(2)} tokens` });
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
    
    // Add error log for webapp
    if (session) {
      session.liveLogs = session.liveLogs || [];
      session.liveLogs.push({ status: 'error', message: `❌ Deployment failed: ${err.message}` });
      session.liveLogs.push({ status: 'completed', message: `❌ Deployment failed!` });
    }
    
    // Show Trade panel even on error
    const { actionMenu } = require('../panels');
    const mainBalance = await getBalance(connection, session?.mainWallet?.pub || session?.mainWallet?.address);
    const tradePanel = actionMenu(session, mainBalance.toFixed(4));
    
    await bot.sendMessage(chatId, 
      `❌ *Deployment Failed:*\n\`${err.message}\``, 
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
 * 🛒 BUY INSTRUCTION BUILDER
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
    
    // Use the SDK's getBuyInstructions with proper parameters
    return await sdk.getBuyInstructions(
      userPublicKey,
      mint,
      globalAccount.feeRecipient,
      tokenAmount,
      maxSolCost
    );
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
  sendTx
};
