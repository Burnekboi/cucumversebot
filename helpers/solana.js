const axios = require('axios');
const FormData = require('form-data');
const { PumpFunSDK } = require('pumpdotfun-sdk');
const { AnchorProvider } = require('@coral-xyz/anchor');

const {
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
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

    const mintKeypair       = Keypair.generate();
    const mintAddress       = mintKeypair.publicKey.toBase58();
    const mainKeypair       = Keypair.fromSecretKey(base58Decode(session.mainWallet.priv));

    await editTerminal(`🏗 *Deploying \`${tokenName}\` on Pump.fun...*\nDev buy: ${initialBuy} SOL`);

    // Build SDK provider
    const provider = new AnchorProvider(connection, makeWallet(mainKeypair), { commitment: 'confirmed' });
    const sdk      = new PumpFunSDK(provider);

    const tokenMetadata = {
      name:        tokenName,
      symbol:      symbol,
      description: description,
      file:        new Blob([Buffer.from(
        data.image_data?.startsWith('data:image')
          ? data.image_data.split(',')[1]
          : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64'
      )], { type: 'image/png' }),
      twitter:  data.links?.twitter  || undefined,
      telegram: data.links?.telegram || undefined,
      website:  data.links?.website  || undefined,
    };

    // Resolve active buyers
    const activeBuyers = (autoBuyEnabled && selectedBotIds.length > 0)
      ? (session.buyers || []).filter((_, i) => selectedBotIds.includes(`bot-${i}`))
      : [];

    const devBuyLamports = BigInt(Math.floor((initialBuy > 0 ? initialBuy : 0.001) * LAMPORTS_PER_SOL));

    console.log(`🚀 Calling SDK createAndBuy | mint: ${mintAddress} | devBuy: ${devBuyLamports} lamports`);

    const createResult = await sdk.createAndBuy(
      mainKeypair,
      mintKeypair,
      tokenMetadata,
      devBuyLamports,
      BigInt(500), // 5% slippage in basis points
      {
        unitLimit:  250000,
        unitPrice:  250000,
      }
    );

    if (!createResult.success) {
      throw new Error(`SDK createAndBuy failed: ${createResult.error || 'unknown error'}`);
    }

    console.log(`✅ Token created! Signature: ${createResult.signature}`);
    session.liveLogs.push({ status: 'success', message: `🚀 Token Deployed! TX: ${createResult.signature?.slice(0, 16)}...` });

    await editTerminal(
      `✅ *Deployment Complete!*\n\n` +
      `💰 Dev Buy: ${initialBuy} SOL\n` +
      `📍 Mint: \`${mintAddress}\`\n` +
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

  } catch (err) {
    console.error('handleDeployRequest error:', err.message);
    await bot.sendMessage(chatId, `❌ *Deployment Failed:*\n\`${err.message}\``, { parse_mode: 'Markdown' });
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

    const sellAmountBigInt = BigInt(Math.floor(sellAmount * 1e6)); // token amount in raw units
    const result = await sdk.sell(
      buyerKeypair,
      new PublicKey(contractAddress),
      sellAmountBigInt,
      BigInt(500), // 5% slippage
      { unitLimit: 250000, unitPrice: 250000 }
    );

    if (!result.success) {
      throw new Error(`SDK sell failed: ${result.error || 'unknown'}`);
    }

    return await getBalance(connection, buyer.pub);
  } catch (err) {
    console.error('sell error:', err.message);
    return null;
  }
}

module.exports = {
  handleDeployRequest,
  getBalance,
  fetchTokenPriceInSol,
  getTokenBalance,
  getTokenValueInSol,
  sellTokenAmount
};
