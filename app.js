require('dotenv').config();
// Suppress punycode deprecation warning from node-telegram-bot-api dependency
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'DeprecationWarning' || !w.message.includes('punycode')) console.warn(w); });
const TelegramBot = require('node-telegram-bot-api');
const { Connection } = require('@solana/web3.js');
const { sessions, getSession } = require('./sessions');
const callbackHandler = require('./handlers/callbackHandler');
const panels = require('./panels');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const mongoose = require("mongoose");

const app = express();

/* =====================================================
   DATABASE
===================================================== */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ Mongo Error:", err));

/* =====================================================
   BOT + SMART RPC CONNECTION
===================================================== */
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://your-app.railway.app
const WEBHOOK_PATH = `/webhook/${process.env.BOT_TOKEN}`;

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

// Split multi-RPC string and helper for random connection
const rpcList = (process.env.RPC_URL || "https://api.mainnet-beta.solana.com").split(',').map(url => url.trim());
function getSmartConnection() {
  const randomRpc = rpcList[Math.floor(Math.random() * rpcList.length)];
  console.log(`📡 Using RPC: ${randomRpc.split('.')[0]}...`);
  return new Connection(randomRpc, 'confirmed');
}
const connection = getSmartConnection();

/* =====================================================
   CUCUMVERSE API BRIDGE
===================================================== */
app.use(cors({
  origin: process.env.WEBAPP_URL || "*", // Supports Vercel URL via Env Var
  credentials: true
}));

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Debug Request Logging
app.use((req, res, next) => {
  if (!req.url.includes('static') && !req.url.includes('/api/balance') && !req.url.includes('/api/status')) {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  }
  next();
});

// THE PROTECTED BALANCE API
app.get('/api/balance/:address', async (req, res) => {
  try {
    const { getBalance } = require('./helpers/solana');
    const bal = await getBalance(connection, req.params.address);
    res.json({ success: true, balance: bal });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// TRADE CONFIG GET — returns current trade config for a user
app.get('/api/trade-config/:chatId', async (req, res) => {
  try {
    const chatId = req.params.chatId;
    const session = await getSession(chatId);
    const tc = session.tradeConfig || {};
    res.json({
      success: true,
      config: {
        slippage: tc.slippage ?? 5,
        minBuy: tc.minBuy ?? 0.01,
        maxBuy: tc.maxBuy ?? 0.05,
        takeProfit: tc.takeProfitPercent ?? 20,
        sellPercent: tc.sellPortionPercent ?? 20
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// TRADE CONFIG POST — saves trade config from web app to session + DB
app.post('/api/trade-config', async (req, res) => {
  try {
    const { chatId, config } = req.body;
    if (!chatId || !config) return res.status(400).json({ success: false, error: 'Missing chatId or config' });

    const session = await getSession(chatId);
    if (!session.tradeConfig) session.tradeConfig = {};

    const tc = session.tradeConfig;
    if (config.slippage !== undefined)   tc.slippage           = parseFloat(config.slippage);
    if (config.minBuy !== undefined)     tc.minBuy             = parseFloat(config.minBuy);
    if (config.maxBuy !== undefined)     tc.maxBuy             = parseFloat(config.maxBuy);
    if (config.takeProfit !== undefined) tc.takeProfitPercent  = parseFloat(config.takeProfit);
    if (config.sellPercent !== undefined) tc.sellPortionPercent = parseFloat(config.sellPercent);

    const { saveTradeConfigToDb } = require('./sessions');
    await saveTradeConfigToDb(chatId, tc);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/status/:chatId', async (req, res) => {
  try {
    const chatId = req.params.chatId;
    if (!chatId || !sessions[chatId]) return res.json({ success: false });
    
    const session = sessions[chatId];
    res.json({
      success: true,
      logs: session.liveLogs || [],
      mintAddress: session.tradeConfig?.contractAddress || null,
      isTrading: session.isTrading || false
    });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/action', async (req, res) => {
  try {
    const { chatId, action } = req.body;
    let session = await getSession(chatId);
    if (!session || !session.mainWallet) return res.json({ success: false, error: "No session" });

    if (action === "STOP_TRADE") {
      const { stopAllTrading } = require('./helpers/trading');
      await stopAllTrading(session);
      bot.sendMessage(chatId, "🛑 *Trade Stopped from Web App*", { parse_mode: 'Markdown' });
      return res.json({ success: true });
    }
    
    if (action === "SELL_ALL") {
      const { sellAllTokens } = require('./helpers/trading');
      await sellAllTokens(bot, connection, session, chatId);
      return res.json({ success: true });
    }

    res.json({ success: false, error: "Unknown action" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// THE PROTECTED API ROUTE
app.post('/api/deploy', async (req, res) => {
  console.log("\n--- 🎯 API MATCH: Deployment logic triggered ---");
  try {
    const { chatId, action, data } = req.body;
    console.log(`📡 Incoming Request | ID: ${chatId} | Action: ${action}`);

    if (action === "DEPLOY_TOKEN") {
      if (!chatId) {
        return res.status(400).json({ success: false, error: "Missing Chat ID" });
      }

      // 1. Get the session (getSession creates one if missing)
      let session = await getSession(chatId);

      // 🔧 REPAIR LOGIC: If the session exists but mainWallet is null, fix it
      if (!session.mainWallet) {
        console.log(`🔧 Repairing empty wallet structure for ${chatId}...`);
        session.mainWallet = { address: null, priv: null };
      }

      // 🔍 DEEP DEBUG: See exactly what the API sees
      console.log(`📦 Session Debug for ${chatId}:`, {
        hasMainWallet: !!session.mainWallet,
        hasPrivKey: !!session.mainWallet?.priv,
        buyerCount: session.buyers?.length || 0
      });

      // 2. Critical Check
      if (!session.mainWallet?.priv) {
        console.log(`⚠️ Wallet missing for ${chatId}.`);
        return res.status(400).json({
          success: false,
          error: "Wallet not initialized. Please go to the Telegram Bot and generate/import a wallet first."
        });
      }

      console.log(`✅ Session Validated for ${chatId}. Starting Engine...`);

      // 3. Send immediate response to stop UI loading spinners
      res.json({ success: true, message: "Engine started" });

      // 4. Import Solana helper
      const { handleDeployRequest } = require('./helpers/solana');

      // 5. Use the Trade Panel Message ID to inject the Live Terminal
      const termMsgId = session.tradePanelMsgId || null;

      // 6. Run Logic asynchronously inside the Trade Panel
      handleDeployRequest(bot, connection, data, chatId, session, termMsgId);
    }
  } catch (err) {
    console.error("❌ API Route Error:", err);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
  console.log("-----------------------------------------------\n");
});

// Telegram webhook endpoint — receives updates from Telegram
app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  console.log(`\n=====================================================`);
  console.log(`🚀 CUCUMVERSE API SERVER LIVE ON PORT ${PORT}`);
  console.log(`=====================================================\n`);

  if (!WEBHOOK_URL) {
    console.error('❌ WEBHOOK_URL env var is not set! Bot will not receive updates.');
    return;
  }

  try {
    await bot.setWebHook(`${WEBHOOK_URL}${WEBHOOK_PATH}`, { drop_pending_updates: true });
    console.log(`🤖 Webhook set: ${WEBHOOK_URL}${WEBHOOK_PATH}`);
  } catch (err) {
    console.error('❌ Failed to set webhook:', err.message);
  }
});

process.once('SIGTERM', () => {
  console.log('🛑 SIGTERM received — shutting down gracefully...');
  server.close(() => process.exit(0));
});

process.once('SIGINT', () => {
  server.close(() => process.exit(0));
});

/* =====================================================
   BOT MESSAGE HANDLERS
===================================================== */
bot.on('message', async (msg) => {
  if (msg.web_app_data || !msg.text) return;

  const chatId = msg.chat.id;
  const idStr = chatId.toString();

  // 1. Ensure a session object exists in RAM NO MATTER WHAT
  if (!sessions[idStr]) {
    // We call createSession but NOT getSession (to avoid DB sync wipe)
    const { createSession } = require('./sessions');
    createSession(idStr);
  }
  const session = sessions[idStr];

  // 2. Handle Pending Input
  if (session.pendingInput && typeof session.pendingInput.resolve === 'function') {
    const { resolve } = session.pendingInput;
    session.pendingInput = null; // Clear trap

    try {
      // Catch delete error so it doesn't stop the import
      await bot.deleteMessage(chatId, msg.message_id).catch(() => {});

      // Execute derivation and save
      await resolve(msg.text.trim(), msg);
      return;
    } catch (err) {
      console.error("❌ CRITICAL: Resolve crashed:", err);
      return bot.sendMessage(chatId, '❌ Error processing wallet.');
    }
  }

  // 3. Normal recovery for commands
  await getSession(chatId);
});

/* =====================================================
   START COMMAND (Restored Original Text + Wallet Fix)
===================================================== */

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  // 1. Create or get the session (getSession is async — must await)
  const session = await getSession(chatId);

  // 2. 🔑 THE FIX: Ensure mainWallet exists so the API doesn't throw "Wallet missing"
  if (!session.mainWallet) {
    session.mainWallet = { address: null, priv: null };
  }

  // 3. Original Message Text Restored
  const sentMsg = await bot.sendMessage(
    chatId,
    `🥒 *Cucumverse Multi Wallet Bot*\n\nA multi-wallet trading assistant for Pump.fun tokens.\n\n• Manage main & buyer wallets\n• Configure trade settings\n• Volume Pumping\n• Stealth Sniper\n• Auto-sell Instant\n\nUse the menu below to begin.`,
    { parse_mode: 'Markdown', ...panels.mainMenu() }
  );
  session.tradePanelMsgId = sentMsg.message_id;
});


/* =====================================================
   CALLBACK HANDLER
===================================================== */

bot.on('callback_query', async (query) => {
  try {
    if (!query) return;
    const chatId = query.message?.chat?.id;
    if (!chatId) return;

    const session = await getSession(chatId);
    if (!session) return;

    await callbackHandler(bot, query, session, connection);

  } catch (err) {
    console.error('Callback error:', err);
    try {
      const chatId = query?.message?.chat?.id;
      if (chatId) await bot.sendMessage(chatId, '❌ Callback error occurred.');
    } catch {}
  }
});
