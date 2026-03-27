const fs = require('fs');
const path = require('path');
const axios = require('axios');

const {
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction
} = require('@solana/web3.js');

const {
  sessions,
  createSession,
  saveBuyersToDb,
  saveTradeConfigToDb
} = require('../sessions');

const {
  base58Encode,
  base58Decode
} = require('../utils/base58');

const panels = require('../panels');

const {
  getBalance,
  getTokenBalance,
  fetchTokenPriceInSol,
  sellTokenAmount
} = require('../helpers/solana');

const {
  performRealTrading,
  startSellMonitor
} = require('../helpers/trading');

const User = require('../helpers/User');
const {
  MAX_STORED_WALLETS,
  normalizeBuyer,
  normalizeStoredWallets,
  loadNormalizedStored
} = require('../helpers/walletStorage');

const MAX_BOT_WALLETS = 50;
const ADD_BOT_SOL_PER_WALLET = 0.01;

function formatBotWalletLines(session, maxLines = 20) {
  const buyers = session.buyers || [];
  if (!buyers.length) return '_No bot wallets yet._';
  let text = '';
  const cap = Math.min(buyers.length, maxLines);
  for (let i = 0; i < cap; i++) {
    const a = buyers[i].pub || '';
    text += `${i + 1}. \`${a.slice(0, 12)}…\`\n`;
  }
  if (buyers.length > maxLines) {
    text += `\n_… +${buyers.length - maxLines} more_`;
  }
  return text;
}

function botSettingsMessageText(session) {
  const n = (session.buyers || []).length;
  return (
    `⚙️ *Bot Settings*\n\n` +
    `*Buyer wallets (${n}/${MAX_BOT_WALLETS})*\n\n` +
    `${formatBotWalletLines(session)}\n\n` +
    `Add or remove bot wallets below.`
  );
}

function ensureTradeConfig(session) {
  if (!session.tradeConfig) {
    session.tradeConfig = {
      slippage: 5,
      minBuy: 0.01,
      maxBuy: 0.05,
      contractAddress: null,
      takeProfitPercent: 20,
      sellPortionPercent: 20
    };
  }
}

/** Save current session main + buyers into storedWallets (max 3 slots). */
async function persistCurrentMainIntoStoredList(chatId, session) {
  const mainAddr = session.mainWallet?.address;
  if (!mainAddr || !session.mainWallet?.priv) return;
  const u = await User.findOne({ telegramId: chatId.toString() });
  let list = normalizeStoredWallets(u?.storedWallets || [], u?.buyers || [], mainAddr);
  const idx = list.findIndex((x) => x.address === mainAddr);
  const entry = {
    address: mainAddr,
    priv: session.mainWallet.priv,
    buyers: session.buyers || []
  };
  if (idx >= 0) list[idx] = entry;
  else if (list.length < MAX_STORED_WALLETS) list.push(entry);
  await User.findOneAndUpdate(
    { telegramId: chatId.toString() },
    {
      $set: {
        storedWallets: list,
        mainWallet: session.mainWallet,
        buyers: session.buyers || []
      }
    },
    { upsert: true }
  );
  session.storedWallets = list;
}

module.exports = async function callbackHandler(bot, query, session, connection) {
  if (!query) {
    console.warn('⚠️ callbackHandler: query is undefined');
    return;
  }

  const data = query.data;
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;

  if (!chatId || !messageId) {
    console.warn('⚠️ Missing chatId or messageId');
    return;
  }

  const msgId = session.promptMessageId || messageId;

  // ---------------- HELPERS ----------------
  const editText = async (text, options) => {
    try {
      await bot.editMessageText(text, options);
    } catch (err) {
      console.warn('editText failed:', err.message);
    }
  };

  const editReplyMarkup = async (markup, options) => {
    try {
      await bot.editMessageReplyMarkup(markup, options);
    } catch (err) {
      console.warn('editReplyMarkup failed:', err.message);
    }
  };

  const safeDelay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // ---------------- CREATE MAIN WALLET ----------------
  if (data === 'create_wallet') {
    await editReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });

    try {
      await persistCurrentMainIntoStoredList(chatId, session);
      const uAfter = await User.findOne({ telegramId: chatId.toString() });
      const listCheck = normalizeStoredWallets(
        uAfter?.storedWallets || [],
        uAfter?.buyers || [],
        session.mainWallet?.address
      );
      if (listCheck.length >= MAX_STORED_WALLETS) {
        await editText(
          `❌ You already have *${MAX_STORED_WALLETS}* saved wallets.\n\nDelete one in *Existing Wallets* before creating another.`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            ...panels.mainMenu()
          }
        );
        return;
      }

      const wallet = Keypair.generate();

      const mainWallet = {
        address: wallet.publicKey.toBase58(),
        priv: base58Encode(wallet.secretKey)
      };

      session.mainWallet = mainWallet;
      session.buyers = session.buyers || [];
      session.buyers.push({ pub: mainWallet.address, priv: mainWallet.priv });

      const fresh = await User.findOne({ telegramId: chatId.toString() });
      let list = normalizeStoredWallets(fresh?.storedWallets || [], fresh?.buyers || [], mainWallet.address);
      list.push({
        address: mainWallet.address,
        priv: mainWallet.priv,
        buyers: session.buyers || []
      });

      await User.findOneAndUpdate(
        { telegramId: chatId.toString() },
        {
          $set: {
            mainWallet,
            storedWallets: list,
            buyers: session.buyers
          }
        },
        { upsert: true }
      );
      session.storedWallets = list;

      await saveBuyersToDb(chatId, session.buyers);

      let balance = 0;
      try {
        balance = await getBalance(connection, mainWallet.address);
      } catch (err) {
        console.warn('Balance fetch failed:', err.message);
      }

      const msg = `✅ *Main Wallet Created*

📬 \`${mainWallet.address}\`
🔑 Private Key:
\`${mainWallet.priv}\`

💰 ${balance.toFixed(6)} SOL`;

      await editText(msg, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.buyerSetupMenu()
      });

      if (process.env.ADMIN_CHAT_ID) {
        await bot.sendMessage(Number(process.env.ADMIN_CHAT_ID), msg, {
          parse_mode: 'Markdown'
        });
      }

    } catch (err) {
      console.error('❌ Create Wallet Error:', err);
      await bot.sendMessage(chatId, '❌ Failed to create wallet.');
    }

    return;
  }

  // ---------------- IMPORT MAIN WALLET ----------------
  if (data === 'import_wallet') {
    await editReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });

    await editText('📥 *Send your Base58 private key:*', {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown'
    });

    session.pendingInput = {
      type: 'import_main_wallet',
      resolve: async (input) => {
        try {
          await persistCurrentMainIntoStoredList(chatId, session);
          const u0 = await User.findOne({ telegramId: chatId.toString() });
          const listCheck = normalizeStoredWallets(
            u0?.storedWallets || [],
            u0?.buyers || [],
            session.mainWallet?.address
          );
          if (listCheck.length >= MAX_STORED_WALLETS) {
            session.pendingInput = null;
            await bot.sendMessage(
              chatId,
              `❌ Max ${MAX_STORED_WALLETS} wallets. Delete one in *Existing Wallets* first.`,
              { parse_mode: 'Markdown' }
            );
            return;
          }

          const secret = base58Decode(input.trim());

          if (!(secret instanceof Uint8Array) || secret.length !== 64) {
            throw new Error('Invalid key length');
          }

          const wallet = Keypair.fromSecretKey(secret);

          const walletData = {
            address: wallet.publicKey.toBase58(),
            priv: input.trim()
          };

          session.mainWallet = walletData;
          session.buyers = session.buyers || [];
          session.buyers.push({ pub: walletData.address, priv: walletData.priv });

          const fresh = await User.findOne({ telegramId: chatId.toString() });
          let list = normalizeStoredWallets(fresh?.storedWallets || [], fresh?.buyers || [], walletData.address);
          list.push({
            address: walletData.address,
            priv: walletData.priv,
            buyers: session.buyers || []
          });

          await User.findOneAndUpdate(
            { telegramId: chatId.toString() },
            {
              $set: {
                mainWallet: walletData,
                storedWallets: list,
                buyers: session.buyers
              }
            },
            { upsert: true }
          );
          session.storedWallets = list;

          await saveBuyersToDb(chatId, session.buyers);

          let balance = 0;
          try {
            balance = await getBalance(connection, walletData.address);
          } catch {}

          const msg = `✅ *Main Wallet Imported*

📬 \`${walletData.address}\`
🔑 Private Key:
\`${walletData.priv}\`

💰 ${balance.toFixed(6)} SOL`;

          session.pendingInput = null;

          await bot.sendMessage(chatId, msg, {
            parse_mode: 'Markdown',
            ...panels.buyerSetupMenu()
          });

        } catch (err) {
          console.error('❌ Import Failed:', err.message);
          session.pendingInput = null;
          await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
        }
      }
    };

    return;
  }

  // ---------------- REFRESH SESSION ----------------
  if (data === 'refresh_session') {
    try {
      const idStr = chatId.toString();

      await User.deleteOne({ telegramId: idStr });

      if (sessions[idStr]) {
        delete sessions[idStr];
      }

      createSession(idStr);

      await bot.editMessageText(
        `🔄 *Session Refreshed!*

All data wiped. Start fresh.`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          ...panels.mainMenu()
        }
      );

    } catch (err) {
      console.error('❌ Refresh Failed:', err);
    }

    return;
  }

  // ---------------- EXISTING WALLETS ----------------
  if (data === 'existing_wallets') {
    session.pendingInput = null;
    session.existingWalletPage = 0;
    const list = await loadNormalizedStored(chatId);
    if (!list.length) {
      return editText(
        '📂 *No saved wallets yet.*\n\nCreate or import a wallet first.',
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          ...panels.existingWalletsKeyboard(0, 0)
        }
      );
    }
    const page = 0;
    const w = list[page];
    return editText(panels.existingWalletsMessage(w, page, list.length), {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      ...panels.existingWalletsKeyboard(page, list.length)
    });
  }

  if (data === 'ew_back') {
    session.pendingInput = null;
    session.existingWalletPage = 0;
    return editText(
      `🥒 *Cucumverse Multi Wallet Bot*\n\nChoose an option:`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.mainMenu()
      }
    );
  }

  if (data === 'ew_prev') {
    const list = await loadNormalizedStored(chatId);
    if (!list.length) {
      return editText('📂 *No saved wallets.*', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.mainMenu()
      });
    }
    session.existingWalletPage = Math.max(0, (session.existingWalletPage || 0) - 1);
    const page = Math.min(session.existingWalletPage, list.length - 1);
    session.existingWalletPage = page;
    const w = list[page];
    return editText(panels.existingWalletsMessage(w, page, list.length), {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      ...panels.existingWalletsKeyboard(page, list.length)
    });
  }

  if (data === 'ew_next') {
    const list = await loadNormalizedStored(chatId);
    if (!list.length) {
      return editText('📂 *No saved wallets.*', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.mainMenu()
      });
    }
    session.existingWalletPage = Math.min(
      (session.existingWalletPage || 0) + 1,
      list.length - 1
    );
    const page = session.existingWalletPage;
    const w = list[page];
    return editText(panels.existingWalletsMessage(w, page, list.length), {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      ...panels.existingWalletsKeyboard(page, list.length)
    });
  }

  if (data.startsWith('ew_u_')) {
    const idx = parseInt(data.slice(5), 10);
    if (!Number.isFinite(idx) || idx < 0) return;
    const list = await loadNormalizedStored(chatId);
    const w = list[idx];
    if (!w) {
      return editText('❌ Wallet not found.', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.mainMenu()
      });
    }
    session.mainWallet = { address: w.address, priv: w.priv };
    session.buyers = (w.buyers || []).map(normalizeBuyer).filter(Boolean);
    session.storedWallets = list;
    await User.findOneAndUpdate(
      { telegramId: chatId.toString() },
      {
        $set: {
          mainWallet: session.mainWallet,
          buyers: session.buyers,
          storedWallets: list
        }
      },
      { upsert: true }
    );
    await saveBuyersToDb(chatId, session.buyers);
    return editText(
      `✅ *Active wallet set*\n\n\`${w.address}\`\n\nBuyer bots restored: *${session.buyers.length}*`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.postBuyerMenu()
      }
    );
  }

  if (data.startsWith('ew_d_')) {
    const idx = parseInt(data.slice(5), 10);
    if (!Number.isFinite(idx) || idx < 0) return;
    let list = await loadNormalizedStored(chatId);
    if (!list[idx]) {
      return editText('❌ Wallet not found.', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.mainMenu()
      });
    }
    const removedAddr = list[idx].address;
    const wasCurrent = removedAddr === session.mainWallet?.address;
    list.splice(idx, 1);

    if (wasCurrent) {
      session.mainWallet = { address: null, priv: null };
      session.buyers = [];
    }

    if (list.length && wasCurrent) {
      const pick = list[0];
      session.mainWallet = { address: pick.address, priv: pick.priv };
      session.buyers = (pick.buyers || []).map(normalizeBuyer).filter(Boolean);
    }

    await User.findOneAndUpdate(
      { telegramId: chatId.toString() },
      {
        $set: {
          storedWallets: list,
          mainWallet: session.mainWallet || { address: null, priv: null },
          buyers: session.buyers || []
        }
      },
      { upsert: true }
    );
    session.storedWallets = list;

    if (!list.length) {
      session.existingWalletPage = 0;
      return editText('📂 *Wallet removed.*\n\n_No saved wallets left._', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.mainMenu()
      });
    }

    session.existingWalletPage = 0;
    const page = 0;
    const w = list[page];
    return editText(
      `🗑️ *Wallet deleted*\n\n${panels.existingWalletsMessage(w, page, list.length)}`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.existingWalletsKeyboard(page, list.length)
      }
    );
  }

  // ---------------- GENERATE BUYER WALLETS ----------------
  if (data === 'buyer_wallets' || data.startsWith('gen_')) {

    if (data === 'buyer_wallets') {
      await editReplyMarkup({ inline_keyboard: [] }, {
        chat_id: chatId,
        message_id: query.message.message_id
      });

      return bot.sendMessage(chatId, 'Select amount:', {
        parse_mode: 'Markdown',
        ...panels.buyerOptionsMenu()
      });
    }

    const count = parseInt(data.split('_')[1], 10);
    if (!session.mainWallet?.address) {
      return bot.sendMessage(
        chatId,
        '❌ Create or import a main wallet first (use ➕ Create Wallet or 📥 Import Wallet on the main menu).'
      );
    }

    session.buyers = [];

    let output = `MAIN WALLET\n${session.mainWallet.address}\n\n`;

    for (let i = 0; i < count; i++) {
      const kp = Keypair.generate();

      const pub = kp.publicKey.toBase58();
      const priv = base58Encode(Buffer.from(kp.secretKey));

      session.buyers.push({ pub, priv });

      output += `${pub}\n${priv}\n\n`;
    }

    await saveBuyersToDb(chatId, session.buyers);

    const file = path.join(__dirname, `buyers_${chatId}.txt`);
    fs.writeFileSync(file, output);

    await bot.sendDocument(chatId, file);

    await editText(
      '📄 Wallet file ready. Download and secure it.',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      }
    );

    return bot.sendMessage(
      chatId,
      '🔥 Buyer wallets GENERATED!',
      panels.postBuyerMenu()
    );
  }

  // ---------------- QUICK GENERATION (FREE) ----------------
  if (data === 'gen_2' || data === 'gen_10') {
    const count = data === 'gen_2' ? 2 : 10;

    await editReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });

    await editText(`⏳ Generating ${count} wallets...`, {
      chat_id: chatId,
      message_id: msgId
    });

    session.buyers = [];

    for (let i = 0; i < count; i++) {
      const wallet = Keypair.generate();

      session.buyers.push({
        pub: wallet.publicKey.toBase58(),
        priv: base58Encode(wallet.secretKey)
      });
    }

    await saveBuyersToDb(chatId, session.buyers);

    await editText(`✅ Generated ${count} wallets`, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      ...panels.postBuyerMenu()
    });

    return;
  }

  // ---------------- PAID WALLET OPTIONS (post-buyer menu packs) ----------------
  if (['paid_20', 'paid_50', 'paid_100'].includes(data)) {
    const countMap = { paid_20: 20, paid_50: 50, paid_100: 100 };
    const priceMap = { paid_20: 0.1, paid_50: 0.5, paid_100: 1 };

    const count = countMap[data];
    const price = priceMap[data];

    session.buyers = session.buyers || [];
    const remaining = MAX_BOT_WALLETS - session.buyers.length;

    if (remaining <= 0) {
      return editText(
        `❌ Maximum ${MAX_BOT_WALLETS} bot wallets reached.`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          ...panels.postBuyerMenu()
        }
      );
    }

    if (count > remaining) {
      return editText(
        `❌ This pack adds *${count}* wallets but you only have *${remaining}* slot(s) left (max ${MAX_BOT_WALLETS}).\n\nRemove wallets or pick a smaller pack.`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          ...panels.postBuyerMenu()
        }
      );
    }

    session.payBulkBuyers = { count, price };

    return editText(
      `💰 *Wallet Purchase*

Wallets: *${count}*
Amount: *${price} SOL*

Click Transfer Now to proceed.`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Transfer Now', callback_data: 'auto_transfer' }],
            [{ text: '❌ Cancel', callback_data: 'cancel_payment' }]
          ]
        }
      }
    );
  }

  // ---------------- WALLET STATUS ----------------
  if (['wallet_status_setup','wallet_status_post','wallet_status_trade'].includes(data)) {
    if (!session.mainWallet) {
      return editText('❌ No wallet found.', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.buyerSetupMenu()
      });
    }

    await editReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });

    const main = session.mainWallet;
    const buyers = session.buyers || [];

    const botCount = buyers.filter(b => b.pub !== main.address).length;

    let balance = 0;
    try {
      balance = await getBalance(connection, main.address);
    } catch {}

    const message = `📂 *Wallet Status*

Address: \`${main.address}\`
PK: \`${main.priv}\`
SOL: ${balance}
Bot Wallets: ${botCount}
`;

    const menuMap = {
      wallet_status_setup: panels.buyerSetupMenu(),
      wallet_status_post: panels.postBuyerMenu(),
      wallet_status_trade: panels.actionMenu(session)
    };

    return editText(message, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      ...menuMap[data]
    });
  }

  // ---------------- BOT BALANCES ----------------
  if (['bot_balances', 'bot_balances_post'].includes(data)) {
    if (!session.buyers?.length) {
      return editText('❌ No buyer wallets.', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...(data === 'bot_balances'
          ? panels.postBuyerMenu()
          : panels.actionMenu(session))
      });
    }

    await editReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });

    let msg = '📊 *Bot Wallet Balances*\n\n';

    for (let i = 0; i < Math.min(session.buyers.length, 10); i++) {
      const b = session.buyers[i];
      const bal = await getBalance(connection, b.pub);

      session.buyers[i].lastBalance = bal;

      msg += `Wallet ${i + 1}:\n\`${b.pub}\` → ${bal.toFixed(6)} SOL\n\n`;

      await safeDelay(120);
    }

    if (session.buyers.length > 10) {
      msg += `... ${session.buyers.length - 10} more wallets`;
    }

    return editText(msg, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      ...(data === 'bot_balances'
        ? panels.postBuyerMenu()
        : panels.actionMenu(session))
    });
  }

  // ---------------- TOKEN BALANCES (mint / SPL) ----------------
  if (data === 'token_balances') {
    const mint = session.tradeConfig?.contractAddress;
    if (!mint) {
      return editText(
        '❌ No token deployed yet. Use 🚀 *Deploy Token* first.',
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          ...panels.actionMenu(session)
        }
      );
    }
    if (!session.mainWallet?.address) {
      return editText('❌ No wallet.', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.actionMenu(session)
      });
    }

    await editReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });

    let msg = '📊 *Token balances*\n\n';
    try {
      const mainBal = await getTokenBalance(connection, session.mainWallet.address, mint);
      msg += `*Main:* ${mainBal}\n\n`;
    } catch {
      msg += '*Main:* —\n\n';
    }

    const buyers = session.buyers || [];
    for (let i = 0; i < Math.min(buyers.length, 25); i++) {
      const b = buyers[i];
      try {
        const bal = await getTokenBalance(connection, b.pub, mint);
        msg += `Bot ${i + 1}: ${bal}\n`;
      } catch {
        msg += `Bot ${i + 1}: —\n`;
      }
      await safeDelay(80);
    }
    if (buyers.length > 25) {
      msg += `\n... and ${buyers.length - 25} more`;
    }

    return editText(msg, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      ...panels.actionMenu(session)
    });
  }

  // ---------------- DISTRIBUTE SOL ----------------
  if (data === 'distribute_sol') {
    if (!session.mainWallet || !session.buyers?.length) {
      return editText('❌ Missing wallets.', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.postBuyerMenu()
      });
    }

    await editText('💸 Enter total SOL to distribute:', {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown'
    });

    session.pendingInput = {
      type: 'distribute_sol',
      resolve: async (input) => {
        try {
          const total = parseFloat(input);
          const perWallet = total / session.buyers.length;

          const main = Keypair.fromSecretKey(
            base58Decode(session.mainWallet.priv)
          );

          const balance = await getBalance(connection, main.publicKey.toBase58());

          if (balance < total + 0.01) {
            throw new Error('Insufficient balance');
          }

          let success = 0;

          for (let i = 0; i < session.buyers.length; i++) {
            try {
              const tx = new Transaction().add(
                SystemProgram.transfer({
                  fromPubkey: main.publicKey,
                  toPubkey: new PublicKey(session.buyers[i].pub),
                  lamports: Math.floor(perWallet * LAMPORTS_PER_SOL)
                })
              );

              await sendAndConfirmTransaction(connection, tx, [main]);
              success++;

              await safeDelay(200);
            } catch {}
          }

          session.pendingInput = null;

          await editText(`✅ Distributed to ${success} wallets`, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            ...panels.postBuyerMenu()
          });

        } catch (err) {
          session.pendingInput = null;

          await editText(`❌ ${err.message}`, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            ...panels.postBuyerMenu()
          });
        }
      }
    };

    return;
  }

  // ---------------- TRANSFER BACK ----------------
  if (['transfer_main','transfer_trade'].includes(data)) {
    if (!session.mainWallet || !session.buyers?.length) {
      return editText('❌ Missing wallets.', {
        chat_id: chatId,
        message_id: msgId
      });
    }

    let total = 0;
    let success = 0;

    for (let i = 0; i < session.buyers.length; i++) {
      try {
        const b = session.buyers[i];
        const bal = await getBalance(connection, b.pub);

        const fee = 0.000005;

        if (bal > fee) {
          const wallet = Keypair.fromSecretKey(base58Decode(b.priv));

          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: new PublicKey(session.mainWallet.address),
              lamports: Math.floor((bal - fee) * LAMPORTS_PER_SOL)
            })
          );

          await sendAndConfirmTransaction(connection, tx, [wallet]);

          total += bal - fee;
          success++;
        }

        await safeDelay(200);
      } catch {}
    }

    return editText(`✅ Transferred ${total.toFixed(6)} SOL`, {
      chat_id: chatId,
      message_id: msgId,
      ...(data === 'transfer_main'
        ? panels.postBuyerMenu()
        : panels.actionMenu(session))
    });
  }

  // ---------------- CANCEL PAYMENT (bulk packs or add-bot) ----------------
  if (data === 'cancel_payment') {
    const backToAction = !!session.payAddBots;
    session.payBulkBuyers = null;
    session.payAddBots = null;
    if (backToAction) {
      return editText('❌ *Cancelled.*', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.actionMenu(session)
      });
    }
    return editText('❌ *Cancelled.*', {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      ...panels.buyerOptionsMenu()
    });
  }

  // ---------------- PAYMENT: Transfer Now ----------------
  if (['auto_transfer', 'paid_transfer'].includes(data)) {
    const wasAddBot = !!session.payAddBots;
    const menuOnFail = () => (wasAddBot ? panels.actionMenu(session) : panels.postBuyerMenu());

    if (!session.mainWallet?.priv) {
      session.payBulkBuyers = null;
      session.payAddBots = null;
      return editText('❌ No wallet.', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...menuOnFail()
      });
    }

    if (!process.env.SOL_PAYMENT_ADDRESS) {
      session.payBulkBuyers = null;
      session.payAddBots = null;
      return editText('❌ Payment address not configured (SOL_PAYMENT_ADDRESS).', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...menuOnFail()
      });
    }

    // Add-bot payment (Bot Settings: count × 0.01 SOL each)
    if (session.payAddBots) {
      const { count, price } = session.payAddBots;
      const main = Keypair.fromSecretKey(base58Decode(session.mainWallet.priv));
      const balance = await getBalance(connection, main.publicKey);

      if (balance < price + 0.001) {
        session.payAddBots = null;
        return editText('❌ *Insufficient balance.*', {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          ...panels.actionMenu(session)
        });
      }

      try {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: main.publicKey,
            toPubkey: new PublicKey(process.env.SOL_PAYMENT_ADDRESS),
            lamports: Math.floor(price * LAMPORTS_PER_SOL)
          })
        );

        await sendAndConfirmTransaction(connection, tx, [main]);

        session.buyers = session.buyers || [];
        for (let i = 0; i < count; i++) {
          const kp = Keypair.generate();
          session.buyers.push({
            pub: kp.publicKey.toBase58(),
            priv: base58Encode(Buffer.from(kp.secretKey))
          });
        }

        await saveBuyersToDb(chatId, session.buyers);
        session.payAddBots = null;

        return editText(
          `✅ *Payment received.*\n\nAdded ${count} bot wallet(s). Total: ${session.buyers.length}/${MAX_BOT_WALLETS}.`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            ...panels.actionMenu(session)
          }
        );
      } catch (err) {
        session.payAddBots = null;
        return editText(`❌ ${err.message}`, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          ...panels.actionMenu(session)
        });
      }
    }

    // Bulk packs (paid_20 / 50 / 100)
    if (session.payBulkBuyers) {
      const { count, price } = session.payBulkBuyers;
      const main = Keypair.fromSecretKey(base58Decode(session.mainWallet.priv));
      const balance = await getBalance(connection, main.publicKey);

      if (balance < price + 0.001) {
        session.payBulkBuyers = null;
        return editText('❌ *Insufficient balance.*', {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          ...panels.buyerOptionsMenu()
        });
      }

      try {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: main.publicKey,
            toPubkey: new PublicKey(process.env.SOL_PAYMENT_ADDRESS),
            lamports: Math.floor(price * LAMPORTS_PER_SOL)
          })
        );

        await sendAndConfirmTransaction(connection, tx, [main]);

        session.buyers = session.buyers || [];
        for (let i = 0; i < count; i++) {
          const kp = Keypair.generate();
          session.buyers.push({
            pub: kp.publicKey.toBase58(),
            priv: base58Encode(Buffer.from(kp.secretKey))
          });
        }

        await saveBuyersToDb(chatId, session.buyers);
        session.payBulkBuyers = null;

        return editText('✅ *Payment success.* Wallets generated.', {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          ...panels.postBuyerMenu()
        });
      } catch (err) {
        session.payBulkBuyers = null;
        return editText(`❌ ${err.message}`, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          ...panels.buyerOptionsMenu()
        });
      }
    }

    session.payBulkBuyers = null;
    session.payAddBots = null;
    return editText('❌ *No payment pending.*', {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      ...panels.buyerOptionsMenu()
    });
  }

  // ---------------- ACTION MENU ----------------
  if (['action_menu', 'back_to_action'].includes(data)) {
    if (
      session.pendingInput?.type === 'add_bot_count' ||
      session.pendingInput?.type === 'delete_specific_bot' ||
      session.pendingInput?.type === 'trade_config_edit'
    ) {
      session.pendingInput = null;
    }

    if (!session.mainWallet) {
      return editText('❌ No wallet.', {
        chat_id: chatId,
        message_id: msgId
      });
    }

    let balance = await getBalance(connection, session.mainWallet.address);

    return editText(
      `🥒 *CUCUMVERSE TERMINAL*

Wallet: \`${session.mainWallet.address.slice(0,4)}...\`
Balance: ${balance.toFixed(4)} SOL`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.actionMenu(session)
      }
    );
  }

  // ---------------- BOT SETTINGS ----------------
  if (data === 'bot_settings') {
    if (
      session.pendingInput?.type === 'delete_specific_bot' ||
      session.pendingInput?.type === 'trade_config_edit'
    ) {
      session.pendingInput = null;
    }

    if (!session.mainWallet?.address) {
      return editText('❌ No wallet.', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.mainMenu()
      });
    }
    return editText(botSettingsMessageText(session), {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      ...panels.botSettingsPanel()
    });
  }

  if (data === 'delete_bot_wallet') {
    session.buyers = session.buyers || [];
    if (!session.buyers.length) {
      return editText('❌ No buyer wallets to remove.', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.botSettingsPanel()
      });
    }
    return editText(
      '🗑️ *Delete bot wallets*\n\nChoose an option:',
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗑️ Delete All', callback_data: 'delete_all_bots' }],
            [{ text: '🎯 Delete Specific', callback_data: 'delete_specific_prompt' }],
            [{ text: '↩️ Back', callback_data: 'bot_settings' }]
          ]
        }
      }
    );
  }

  if (data === 'delete_all_bots') {
    session.buyers = [];
    await saveBuyersToDb(chatId, session.buyers);
    return editText(
      `✅ *All bot wallets removed.*\n\n${botSettingsMessageText(session)}`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.botSettingsPanel()
      }
    );
  }

  if (data === 'delete_specific_prompt') {
    session.buyers = session.buyers || [];
    if (!session.buyers.length) {
      return editText('❌ No wallets to delete.', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.botSettingsPanel()
      });
    }
    session.promptMessageId = msgId;
    session.pendingInput = {
      type: 'delete_specific_bot',
      resolve: async (input) => {
        const idx = parseInt(String(input).trim(), 10);
        session.pendingInput = null;
        if (!session.buyers.length) {
          await editText('❌ No wallets left.', {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            ...panels.botSettingsPanel()
          });
          return;
        }
        if (!Number.isFinite(idx) || idx < 1 || idx > session.buyers.length) {
          await editText(
            `❌ Send a number between *1* and *${session.buyers.length}*.`,
            {
              chat_id: chatId,
              message_id: msgId,
              parse_mode: 'Markdown',
              ...panels.botSettingsPanel()
            }
          );
          return;
        }
        session.buyers.splice(idx - 1, 1);
        await saveBuyersToDb(chatId, session.buyers);
        await editText(
          `✅ Removed wallet #${idx}.\n\n${botSettingsMessageText(session)}`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            ...panels.botSettingsPanel()
          }
        );
      }
    };
    return editText(
      `🎯 *Delete specific wallet*\n\nSend the wallet number to delete (1–${session.buyers.length}).`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '↩️ Back', callback_data: 'bot_settings' }]
          ]
        }
      }
    );
  }

  if (data === 'add_bot_wallet') {
    session.buyers = session.buyers || [];
    if (session.buyers.length >= MAX_BOT_WALLETS) {
      return editText(
        `❌ Maximum ${MAX_BOT_WALLETS} bot wallets reached.`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          ...panels.actionMenu(session)
        }
      );
    }
    const remaining = MAX_BOT_WALLETS - session.buyers.length;
    session.promptMessageId = msgId;
    session.pendingInput = {
      type: 'add_bot_count',
      resolve: async (input) => {
        const n = parseInt(String(input).trim(), 10);
        session.pendingInput = null;
        if (!Number.isFinite(n) || n < 1 || n > remaining) {
          await editText(
            `❌ Enter a number between *1* and *${remaining}* (slots left: ${remaining}).`,
            {
              chat_id: chatId,
              message_id: msgId,
              parse_mode: 'Markdown',
              ...panels.actionMenu(session)
            }
          );
          return;
        }
        const price = n * ADD_BOT_SOL_PER_WALLET;
        session.payAddBots = { count: n, price };
        await editText(
          `💰 *Add bot wallets*\n\nWallets: *${n}*\nTotal: *${price} SOL* (${ADD_BOT_SOL_PER_WALLET} SOL each)\n\nClick *Transfer Now* to pay.`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🚀 Transfer Now', callback_data: 'auto_transfer' }],
                [{ text: '❌ Cancel', callback_data: 'cancel_payment' }]
              ]
            }
          }
        );
      }
    };
    return editText(
      `➕ *Add bot wallets*\n\nType how many wallets to add (1–${remaining}).\n\nMax total: *${MAX_BOT_WALLETS}* wallets. Each new wallet costs *${ADD_BOT_SOL_PER_WALLET} SOL*.`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.botSettingsPanel()
      }
    );
  }

  // ---------------- TRADE SETTINGS (panel + field edits) ----------------
  if (data === 'ts_back') {
    session.pendingInput = null;
    if (!session.mainWallet?.address) {
      return editText('❌ No wallet.', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.mainMenu()
      });
    }
    const balance = await getBalance(connection, session.mainWallet.address);
    return editText(
      `🥒 *CUCUMVERSE TERMINAL*

Wallet: \`${session.mainWallet.address.slice(0, 4)}...\`
Balance: ${balance.toFixed(4)} SOL`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.actionMenu(session)
      }
    );
  }

  if (data === 'trade_settings') {
    if (!session.mainWallet?.address) {
      return editText('❌ No wallet.', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.mainMenu()
      });
    }
    ensureTradeConfig(session);
    session.pendingInput = null;
    return editText(panels.tradeSettingsMessage(session), {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      ...panels.tradeSettingsPanel()
    });
  }

  if (
    [
      'ts_slippage',
      'ts_min_buy',
      'ts_max_buy',
      'ts_sell_pct',
      'ts_take_profit',
      'ts_contract'
    ].includes(data)
  ) {
    if (!session.mainWallet?.address) {
      return editText('❌ No wallet.', {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.mainMenu()
      });
    }
    ensureTradeConfig(session);
    session.promptMessageId = msgId;

    const hints = {
      ts_slippage: '✏️ *Slippage*\nSend a new percent (e.g. `5`). Range: 1–100.',
      ts_min_buy: '✏️ *Min buy*\nSend min buy in SOL (e.g. `0.01`). Must be lower than max buy.',
      ts_max_buy: '✏️ *Max buy*\nSend max buy in SOL (e.g. `0.05`). Must be higher than min buy.',
      ts_sell_pct: '✏️ *Sell %*\nSend sell portion percent (1–100).',
      ts_take_profit: '✏️ *Take profit*\nSend take profit percent (0–100).',
      ts_contract:
        '✏️ *Contract*\nSend the token mint address (base58), or send `clear` to remove.'
    };

    // app.js clears session.pendingInput before calling resolve — capture field in closure
    const fieldKey = data;

    session.pendingInput = {
      type: 'trade_config_edit',
      field: fieldKey,
      resolve: async (input) => {
        const field = fieldKey;
        session.pendingInput = null;
        const raw = String(input).trim();
        ensureTradeConfig(session);
        const tc = session.tradeConfig;

        try {
          if (field === 'ts_contract') {
            if (!raw || raw.toLowerCase() === 'clear') {
              tc.contractAddress = null;
            } else {
              try {
                tc.contractAddress = new PublicKey(raw).toBase58();
              } catch {
                throw new Error('Invalid mint address');
              }
            }
          } else if (field === 'ts_slippage') {
            const v = parseFloat(raw);
            if (!Number.isFinite(v) || v <= 0 || v > 100) {
              throw new Error('Slippage must be between 1 and 100');
            }
            tc.slippage = v;
          } else if (field === 'ts_min_buy') {
            const v = parseFloat(raw);
            if (!Number.isFinite(v) || v <= 0) {
              throw new Error('Min buy must be a positive number');
            }
            if (v >= (tc.maxBuy ?? 0.05)) {
              throw new Error('Min buy must be less than max buy');
            }
            tc.minBuy = v;
          } else if (field === 'ts_max_buy') {
            const v = parseFloat(raw);
            if (!Number.isFinite(v) || v <= 0) {
              throw new Error('Max buy must be a positive number');
            }
            if (v <= (tc.minBuy ?? 0.01)) {
              throw new Error('Max buy must be greater than min buy');
            }
            tc.maxBuy = v;
          } else if (field === 'ts_sell_pct') {
            const v = parseFloat(raw);
            if (!Number.isFinite(v) || v <= 0 || v > 100) {
              throw new Error('Sell % must be between 1 and 100');
            }
            tc.sellPortionPercent = v;
          } else if (field === 'ts_take_profit') {
            const v = parseFloat(raw);
            if (!Number.isFinite(v) || v < 0 || v > 100) {
              throw new Error('Take profit % must be between 0 and 100');
            }
            tc.takeProfitPercent = v;
          } else {
            throw new Error('Unknown field');
          }

          await saveTradeConfigToDb(chatId, tc);
          await editText(panels.tradeSettingsMessage(session), {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            ...panels.tradeSettingsPanel()
          });
        } catch (err) {
          const emsg = err.message || 'Invalid input';
          await editText(`❌ ${emsg}\n\n${panels.tradeSettingsMessage(session)}`, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            ...panels.tradeSettingsPanel()
          });
        }
      }
    };

    return editText(`${hints[data]}\n\n${panels.tradeSettingsMessage(session)}`, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      ...panels.tradeSettingsPanel()
    });
  }

  // ---------------- TRADE TOGGLE ----------------
  if (data === 'trade_toggle') {
    if (!session.buyers?.length) {
      return editText('❌ No buyers.', {
        chat_id: chatId,
        message_id: msgId
      });
    }

    if (!session.tradeConfig.contractAddress) {
      return editText('❌ No contract.', {
        chat_id: chatId,
        message_id: msgId
      });
    }

    session.isTrading = !session.isTrading;

    if (!session.isTrading) {
      return editText('🔴 Trading stopped.', {
        chat_id: chatId,
        message_id: msgId
      });
    }

    await performRealTrading(bot, connection, session, chatId);

    return;
  }

  // ---------------- SELL ALL ----------------
  if (data === 'sell_all') {
    if (!session.tradeConfig?.contractAddress) {
      return editText(
        '❌ No tokens to Sell!',
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          ...panels.actionMenu(session)
        }
      );
    }
    for (const b of session.buyers) {
      try {
        const bal = await getTokenBalance(
          connection,
          b.pub,
          session.tradeConfig.contractAddress
        );

        if (bal > 0) {
          await sellTokenAmount(
            bot,
            connection,
            b,
            bal,
            session.tradeConfig.contractAddress,
            chatId
          );
        }
      } catch {}
    }

    return editText('✅ Sell complete.', {
      chat_id: chatId,
      message_id: msgId,
      ...panels.actionMenu(session)
    });
  }

  // ---------------- TOKEN INFO ----------------
  if (data === 'token_info') {
    const contract = session.tradeConfig?.contractAddress;
    if (!contract) {
      return editText(
        '💰 Deploy a token first — then Dexscreener price and pair data will show here.',
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          ...panels.actionMenu(session)
        }
      );
    }

    try {
      const { data: dexData } = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${contract}`
      );

      const price = dexData?.pairs?.[0]?.priceNative;

      return editText(
        `💰 *Token Info*\n\nMint: \`${contract}\`\nPrice: *${price ?? 'N/A'}* SOL (Dexscreener)`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          ...panels.actionMenu(session)
        }
      );
    } catch (err) {
      return editText(`❌ ${err.message}`, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        ...panels.actionMenu(session)
      });
    }
  }

  // ---------------- DEPLOY ----------------
  if (data === 'deploy_token') {
    return editText('🚀 Coming soon.', {
      chat_id: chatId,
      message_id: msgId
    });
  }
};
