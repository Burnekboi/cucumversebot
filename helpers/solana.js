const axios = require('axios');
const FormData = require('form-data');

const {
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair
} = require('@solana/web3.js');

const { base58Decode } = require('../utils/base58');
const User = require('./User');

/**
 * ===============================
 * 🚀 MAIN DEPLOYMENT HANDLER
 * ===============================
 */
async function handleDeployRequest(bot, connection, data, chatId, session, termMsgId = null) {
  try {
    const { performRealTrading } = require('./trading');

    const editTerminal = async (text) => {
       if (termMsgId) {
           await bot.editMessageText(`🥒 *CUCUMVERSE DEPLOYMENT TERMINAL*\n➖➖➖➖➖➖➖➖➖➖\n${text}`, { 
               chat_id: chatId, 
               message_id: termMsgId, 
               parse_mode: 'Markdown',
               disable_web_page_preview: true
           }).catch(() => {});
       } else {
           await bot.sendMessage(chatId, `🥒 *CUCUMVERSE DEPLOYMENT TERMINAL*\n➖➖➖➖➖➖➖➖➖➖\n${text}`, { 
               parse_mode: 'Markdown',
               disable_web_page_preview: true
           });
       }
    };

    // ---------------- SAFETY CHECK ----------------
    if (!session || !session.mainWallet || !session.mainWallet.priv) {
      console.log(`❌ Deployment aborted for ${chatId}: Wallet missing`);
      throw new Error("No active wallet found. Please import or create one.");
    }

    // ---------------- INPUT MAPPING ----------------
    const tokenName = data.name || data.tokenName || "Cucumverse Token";
    const symbol = data.symbol || "CUCUM";
    const description = data.description || "";
    const initialBuy = parseFloat(data.initial_buy_sol) || 0;

    const selectedBotIds = data.bot_fleet || [];
    const autoBuyEnabled = data.auto_buy || false;

    session.liveLogs = [];

    await editTerminal("☁️ *Uploading metadata and image to IPFS...*");

    // ---------------- IMAGE HANDLING ----------------
    const formData = new FormData();

    if (data.image_data && data.image_data.startsWith('data:image')) {
      const base64 = data.image_data.split(',')[1];

      formData.append(
        "file",
        Buffer.from(base64, 'base64'),
        {
          filename: "token_image.png",
          contentType: 'image/png'
        }
      );
    } else {
      const imageSource = data.image || data.tokenImage;

      if (!imageSource) {
        throw new Error("No token image provided.");
      }

      const imageRes = await axios.get(imageSource, {
        responseType: 'arraybuffer'
      });

      formData.append(
        "file",
        Buffer.from(imageRes.data),
        "token_image.png"
      );
    }

    // ---------------- METADATA ----------------
    formData.append("name", tokenName);
    formData.append("symbol", symbol);
    formData.append("description", description);
    formData.append("twitter", data.links?.twitter || "");
    formData.append("telegram", data.links?.telegram || "");
    formData.append("website", data.links?.website || "");
    formData.append("showName", "true");

    const ipfsResponse = await axios.post(
      "https://pump.fun/api/ipfs",
      formData,
      { headers: { ...formData.getHeaders() } }
    );

    const metadataUri = ipfsResponse.data.metadataUri;

    // ---------------- PUMPPORTAL DEPLOYMENT ----------------
    session.liveLogs = session.liveLogs || [];
    session.liveLogs.push({
      status: 'processing',
      message: `🏗 Initializing Atomic Deployment for ${symbol}...`
    });

    const mintKeypair = Keypair.generate();
    const mintAddress = mintKeypair.publicKey.toBase58();

    await editTerminal(`🏗 *Initializing Atomic Deployment...*\nCreating \`${tokenName}\` on Pump.fun and executing DEV buy of ${initialBuy} SOL...`);

    const pumpportalPayload = [
      {
        publicKey: session.mainWallet.address,
        action: "create",
        tokenMetadata: {
            name: tokenName,
            symbol: symbol,
            uri: metadataUri
        },
        mint: mintAddress,
        denominatedInSol: "true",
        amount: initialBuy,
        slippage: 10,
        priorityFee: 0.005,
        pool: "pump"
      }
    ];

    const response = await axios.post("https://pumpportal.fun/api/trade-local", pumpportalPayload, {
      headers: { "Content-Type": "application/json" }
    });

    // PumpPortal returns a JSON array of base58-encoded transactions
    const encodedTx = Array.isArray(response.data) ? response.data[0] : response.data;
    if (!encodedTx || typeof encodedTx !== 'string') {
      throw new Error(`Unexpected response from PumpPortal: ${JSON.stringify(response.data)}`);
    }

    const txBytes = base58Decode(encodedTx);
    const tx = VersionedTransaction.deserialize(txBytes);
    const mainWalletKeypair = Keypair.fromSecretKey(base58Decode(session.mainWallet.priv));

    // Sign with mint keypair AND dev wallet keypair (mint must be first for create)
    tx.sign([mintKeypair, mainWalletKeypair]);

    session.liveLogs.push({
      status: 'processing',
      message: `✍️ Executing Deployment & DEV BUY (${initialBuy} SOL)...`
    });

    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });

    session.liveLogs.push({
      status: 'success',
      message: `🚀 Deployment Confirmed! DEV Buy Executed.`
    });

    await editTerminal(
      `🚀 *Token Deployed & Initial Buy Confirmed!*\n\n` +
      `💰 Initial Buy: ${initialBuy} SOL\n` +
      `📍 Mint: \`${mintAddress}\`\n` +
      `🔗 [Pump.fun](https://pump.fun/${mintAddress})\n` +
      `🔗 Tx: \`https://solscan.io/tx/${signature}\``
    );

    // ---------------- SAVE CONTRACT ----------------
    if (!session.tradeConfig) {
      session.tradeConfig = {};
    }

    session.tradeConfig.contractAddress = mintAddress;
    
    // ✅ Apply Frontend Trade Config to Bot Session
    if (data.config) {
      session.tradeConfig.slippage = parseFloat(data.config.slippage) || 1.0;
      session.tradeConfig.minBuy = parseFloat(data.config.minBuy) || 0.01;
      session.tradeConfig.maxBuy = parseFloat(data.config.maxBuy) || 0.1;
      session.tradeConfig.sellPortionPercent = parseFloat(data.config.sellPercent) || 100;
      session.tradeConfig.takeProfitPercent = parseFloat(data.config.takeProfit) || 50; 
    }

    await editTerminal(
      `✅ **Deployment Sequence Complete!**\n\n` +
      `💰 Initial Buy: ${initialBuy} SOL\n` +
      `📍 Mint: \`${mintAddress}\`\n` +
      `🔗 [Pump.fun](https://pump.fun/${mintAddress})\n` +
      `🔗 Tx: \`https://solscan.io/tx/${signature}\``
    );

    session.liveLogs.push({
      status: 'success',
      message: `🎉 ${symbol} token deployed succesfully!`
    });

    // ---------------- SWARM BUY ----------------
    if (autoBuyEnabled && selectedBotIds.length > 0) {
      // bot_fleet contains ids like "bot-0", "bot-1" — match by index
      const activeBuyers = (session.buyers || []).filter((_, index) =>
        selectedBotIds.includes(`bot-${index}`)
      );

      if (activeBuyers.length > 0) {
        await editTerminal(
          `✅ *Deployment Complete! Swarm Engaged* 🤖\n\n` +
          `💰 Initial Buy: ${initialBuy} SOL\n` +
          `📍 Mint: \`${mintAddress}\`\n` +
          `🔗 [Pump.fun](https://pump.fun/${mintAddress})\n` +
          `🔗 Tx: \`https://solscan.io/tx/${signature}\`\n\n` +
          `🚀 *Swarm buying with ${activeBuyers.length} wallets...*`
        );

        // Wait for deploy tx to confirm before bots try to buy
        await connection.confirmTransaction(signature, 'confirmed').catch(() => {});

        const originalBuyers = session.buyers;
        session.buyers = activeBuyers;

        await performRealTrading(bot, connection, session, chatId);

        session.buyers = originalBuyers;
      }
    }

  } catch (err) {
    console.error('handleDeployRequest error:', err.message);

    const msg = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;

    await bot.sendMessage(
      chatId,
      `❌ **Deployment Failed:**\n\`${msg}\``,
      { parse_mode: 'Markdown' }
    );
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

    const lamports = await connection.getBalance(
      new PublicKey(pubkey)
    );

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
    const res = await axios.get(
      `https://api.pumpfunapi.org/price/${mintAddress}`
    );

    return res.data?.SOL
      ? parseFloat(res.data.SOL)
      : 0;

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
    const wallet = new PublicKey(pubKey);
    const mint = new PublicKey(mintAddress);

    const res = await connection.getParsedTokenAccountsByOwner(
      wallet,
      { mint }
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
  const price = await fetchTokenPriceInSol(mintAddress);

  return balance * price;
}

/**
 * ===============================
 * 🔻 SELL TOKENS
 * ===============================
 */
async function sellTokenAmount(
  bot,
  connection,
  buyer,
  sellAmount,
  contractAddress,
  chatId,
  walletIndex
) {
  try {
    const body = [{
      publicKey: buyer.pub,
      action: "sell",
      mint: contractAddress,
      amount: sellAmount,
      denominatedInSol: "false",
      slippage: 5,
      priorityFee: 0.005,
      pool: "auto"
    }];

    const res = await axios.post(
      'https://pumpportal.fun/api/trade-local',
      body,
      { headers: { 'Content-Type': 'application/json' } }
    );

    const encodedTx = Array.isArray(res.data) ? res.data[0] : res.data;
    if (!encodedTx || typeof encodedTx !== 'string') {
      throw new Error(`Bad PumpPortal response: ${JSON.stringify(res.data)}`);
    }

    const tx = VersionedTransaction.deserialize(base58Decode(encodedTx));

    const buyerKey = buyer.priv;

    tx.sign([
      Keypair.fromSecretKey(base58Decode(buyerKey))
    ]);

    const signature = await connection.sendRawTransaction(
      tx.serialize(),
      { skipPreflight: true }
    );

    return await getBalance(connection, buyer.pub);

  } catch (err) {
    console.error('sell error:', err.message);
    return null;
  }
}

/**
 * ===============================
 * 📦 EXPORTS
 * ===============================
 */
module.exports = {
  handleDeployRequest,
  getBalance,
  fetchTokenPriceInSol,
  getTokenBalance,
  getTokenValueInSol,
  sellTokenAmount
};
