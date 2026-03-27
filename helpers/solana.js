const axios = require('axios');
const FormData = require('form-data');

const {
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair
} = require('@solana/web3.js');

const { base58Decode, base58Encode } = require('../utils/base58');

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
          chat_id: chatId,
          message_id: termMsgId,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        }).catch(() => {});
      } else {
        await bot.sendMessage(chatId, msg, {
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
    const tokenName        = data.name || data.tokenName || "Cucumverse Token";
    const symbol           = data.symbol || "CUCUM";
    const description      = data.description || "";
    const initialBuy       = parseFloat(data.initial_buy_sol) || 0;
    const selectedBotIds   = data.bot_fleet || [];
    const autoBuyEnabled   = data.auto_buy || false;
    const jitoBundleEnabled = data.jito_bundle || false;

    session.liveLogs = [];

    // ---------------- BOT WALLET PRE-FLIGHT CHECK ----------------
    if (autoBuyEnabled && selectedBotIds.length > 0) {
      const activeBuyersPreflight = (session.buyers || []).filter((_, index) =>
        selectedBotIds.includes(`bot-${index}`)
      );

      if (activeBuyersPreflight.length > 0) {
        const tc        = session.tradeConfig || {};
        const minBuy    = tc.minBuy ?? 0.01;
        const maxBuy    = tc.maxBuy ?? 0.05;
        const feeBuffer = 0.005;

        const balances       = await Promise.all(activeBuyersPreflight.map(b => getBalance(connection, b.pub)));
        const maxBotSol      = Math.max(...balances);
        const insufficientBots = balances.filter(b => b < minBuy + feeBuffer).length;

        if (maxBuy > maxBotSol) {
          await bot.sendMessage(chatId,
            `⚠️ *Trade Config Warning*\n\nYour *Max Buy* is set to *${maxBuy} SOL* but the highest bot wallet balance is only *${maxBotSol.toFixed(4)} SOL*.\n\nPlease adjust your Trade Config so *Max Buy ≤ ${maxBotSol.toFixed(4)} SOL* before deploying.\n\nGo to ⚙️ Trade Settings to update.`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        if (insufficientBots === activeBuyersPreflight.length) {
          await bot.sendMessage(chatId,
            `⚠️ *Insufficient Bot Balances*\n\nAll selected bot wallets have less than *${(minBuy + feeBuffer).toFixed(4)} SOL* (min buy + fees).\n\nPlease fund your bot wallets or lower *Min Buy* in Trade Settings.`,
            { parse_mode: 'Markdown' }
          );
          return;
        }
      }
    }

    await editTerminal("☁️ *Uploading metadata and image to IPFS...*");

    // ---------------- IMAGE HANDLING ----------------
    const formData = new FormData();

    if (data.image_data && data.image_data.startsWith('data:image')) {
      const base64 = data.image_data.split(',')[1];
      formData.append("file", Buffer.from(base64, 'base64'), {
        filename: "token_image.png",
        contentType: 'image/png'
      });
    } else if (data.image || data.tokenImage) {
      const imageSource = data.image || data.tokenImage;
      try {
        const imageRes = await axios.get(imageSource, { responseType: 'arraybuffer' });
        formData.append("file", Buffer.from(imageRes.data), "token_image.png");
      } catch (imgErr) {
        console.error('Image fetch error:', imgErr.message);
        throw new Error(`Failed to fetch token image: ${imgErr.message}`);
      }
    } else {
      console.log('⚠️ No token image provided, using default placeholder');
      const defaultImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      formData.append("file", Buffer.from(defaultImageBase64, 'base64'), {
        filename: "token_image.png",
        contentType: 'image/png'
      });
    }

    // ---------------- METADATA ----------------
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
        'Origin':     'https://pump.fun',
        'Referer':    'https://pump.fun/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 15000,
      validateStatus: () => true
    });

    console.log('📥 IPFS response status:', ipfsResponse.status, '| data:', JSON.stringify(ipfsResponse.data)?.slice(0, 300));

    if (ipfsResponse.status !== 200) {
      const errBody = typeof ipfsResponse.data === 'object'
        ? JSON.stringify(ipfsResponse.data)
        : String(ipfsResponse.data);
      throw new Error(`IPFS upload failed (${ipfsResponse.status}): ${errBody}`);
    }

    const metadataUri = ipfsResponse.data?.metadataUri;
    if (!metadataUri) throw new Error(`IPFS upload returned no metadataUri: ${JSON.stringify(ipfsResponse.data)}`);

    // ---------------- PUMPPORTAL DEPLOYMENT ----------------
    session.liveLogs.push({ status: 'processing', message: `🏗 Initializing Atomic Deployment for ${symbol}...` });

    const mintKeypair       = Keypair.generate();
    const mintAddress       = mintKeypair.publicKey.toBase58();
    const mainWalletKeypair = Keypair.fromSecretKey(base58Decode(session.mainWallet.priv));

    await editTerminal(`🏗 *Initializing Atomic Deployment...*\nCreating \`${tokenName}\` on Pump.fun and executing DEV buy of ${initialBuy} SOL...`);

    // Resolve active buyers for both Jito bundle and swarm
    const activeBuyers = (autoBuyEnabled && selectedBotIds.length > 0)
      ? (session.buyers || []).filter((_, i) => selectedBotIds.includes(`bot-${i}`))
      : [];

    // Pump.fun bonding curve: SOL → token amount (UI units)
    const VIRTUAL_SOL_RESERVES   = 30;
    const VIRTUAL_TOKEN_RESERVES = 1_073_000_000;
    function solToTokens(solAmount) {
      return Math.floor((VIRTUAL_TOKEN_RESERVES * solAmount) / (VIRTUAL_SOL_RESERVES + solAmount));
    }

    const devBuyTokens = initialBuy > 0 ? solToTokens(initialBuy) : 1_000_000;

    const bundleArgs = [{
      publicKey:     session.mainWallet.address,
      action:        "create",
      tokenMetadata: { name: tokenName, symbol, uri: metadataUri },
      mint:          mintAddress,
      denominatedInSol: "false",
      amount:        devBuyTokens,
      slippage:      10,
      priorityFee:   0.005,
      pool:          "pump"
    }];

    const tc     = session.tradeConfig || {};
    const minBuy = tc.minBuy ?? 0.01;
    const maxBuy = tc.maxBuy ?? 0.05;

    let jitoBotBuyers = [];
    if (jitoBundleEnabled && activeBuyers.length > 0) {
      const slots = 5 - bundleArgs.length;
      jitoBotBuyers = activeBuyers.slice(0, slots);
      for (const buyer of jitoBotBuyers) {
        const buyAmountSol = Math.random() * (maxBuy - minBuy) + minBuy;
        bundleArgs.push({
          publicKey:        buyer.pub,
          action:           "buy",
          mint:             mintAddress,
          denominatedInSol: "false",
          amount:           solToTokens(buyAmountSol),
          slippage:         tc.slippage ?? 10,
          priorityFee:      0.005,
          pool:             "pump"
        });
      }
    }

    // Fetch all unsigned txs from PumpPortal
    console.log('📤 PumpPortal bundle payload:', JSON.stringify(bundleArgs, null, 2));
    const response = await axios.post("https://pump.fun/api/trade-local", bundleArgs, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
      validateStatus: () => true
    });

    console.log('📥 PumpPortal response status:', response.status, '| data:', JSON.stringify(response.data)?.slice(0, 200));

    if (response.status !== 200) {
      const errBody = Array.isArray(response.data?.data)
        ? Buffer.from(response.data.data).toString()
        : JSON.stringify(response.data);
      throw new Error(`PumpPortal ${response.status}: ${errBody}`);
    }

    if (!Array.isArray(response.data) || response.data.length === 0) {
      throw new Error(`Unexpected PumpPortal response: ${JSON.stringify(response.data)}`);
    }

    // Sign each tx with the correct keypair
    const signedTxs = response.data.map((encodedTx, index) => {
      const tx = VersionedTransaction.deserialize(base58Decode(encodedTx));
      if (bundleArgs[index].action === "create") {
        tx.sign([mintKeypair, mainWalletKeypair]);
      } else if (bundleArgs[index].publicKey === session.mainWallet.address) {
        tx.sign([mainWalletKeypair]);
      } else {
        const buyer = jitoBotBuyers.find(b => b.pub === bundleArgs[index].publicKey);
        if (buyer) tx.sign([Keypair.fromSecretKey(base58Decode(buyer.priv))]);
      }
      return base58Encode(tx.serialize());
    });

    session.liveLogs.push({ status: 'processing', message: `✍️ Submitting Jito bundle (${signedTxs.length} txs)...` });

    // Submit bundle to Jito
    const jitoResponse = await axios.post(
      "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
      { jsonrpc: "2.0", id: 1, method: "sendBundle", params: [signedTxs] },
      { headers: { "Content-Type": "application/json" } }
    );

    const bundleId = jitoResponse.data?.result;
    console.log(`✅ Jito bundle submitted: ${bundleId}`);

    // Wait for bundle to land
    await new Promise(r => setTimeout(r, 8000));

    session.liveLogs.push({ status: 'success', message: `🚀 Token Deployed!` });

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

    // ---------------- SWARM BUY (non-Jito path) ----------------
    const remainingBuyers = jitoBundleEnabled
      ? activeBuyers.slice(jitoBotBuyers.length)
      : activeBuyers;

    if (remainingBuyers.length > 0) {
      await editTerminal(
        `🤖 *Swarm Engaged!*\n\n` +
        `📍 Mint: \`${mintAddress}\`\n` +
        `  *${remainingBuyers.length} bot wallets buying now...*`
      );
      const originalBuyers = session.buyers;
      session.buyers = remainingBuyers;
      await performRealTrading(bot, connection, session, chatId);
      session.buyers = originalBuyers;
    }

  } catch (err) {
    console.error('handleDeployRequest error:', err.message);
    let msg = err.message;
    if (err.response?.data) {
      const d = err.response.data;
      if (d?.type === 'Buffer' && Array.isArray(d.data)) {
        msg = Buffer.from(d.data).toString();
      } else if (Buffer.isBuffer(d)) {
        msg = d.toString();
      } else if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) {
        msg = Buffer.from(d).toString();
      } else {
        msg = JSON.stringify(d);
      }
    }
    console.error('Deployment error detail:', msg);
    await bot.sendMessage(chatId, `❌ *Deployment Failed:*\n\`${msg}\``, { parse_mode: 'Markdown' });
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
 *   TOKEN VALUE (SOL)
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
    const res = await axios.post('https://pump.fun/api/trade-local', {
      publicKey:        buyer.pub,
      action:           "sell",
      mint:             contractAddress,
      amount:           sellAmount,
      denominatedInSol: "false",
      slippage:         5,
      priorityFee:      0.005,
      pool:             "pump"
    }, { responseType: 'arraybuffer' });

    if (res.data.byteLength < 100) {
      throw new Error(`PumpPortal sell error: ${Buffer.from(res.data).toString()}`);
    }

    const tx = VersionedTransaction.deserialize(new Uint8Array(res.data));
    tx.sign([Keypair.fromSecretKey(base58Decode(buyer.priv))]);

    await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });

    return await getBalance(connection, buyer.pub);
  } catch (err) {
    console.error('sell error:', err.message);
    return null;
  }
}

/**
 * ===============================
 *   EXPORTS
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
