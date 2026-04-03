function mainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '➕ Create Wallet', callback_data: 'create_wallet' },
          { text: '📥 Import Wallet', callback_data: 'import_wallet' }
        ],
        [{ text: '📂 Existing Wallets', callback_data: 'existing_wallets' }],
        [{ text: '❓ How to Use', callback_data: 'how_to_use' }],
        [{ text: '🔄 Refresh Session (Wipe Data)', callback_data: 'refresh_session' }]
      ]
    }
  };
}

function existingWalletsMessage(wallet, pageIndex, total) {
  if (!wallet) {
    return '📂 *Existing Wallets*\n\n_No saved wallets yet._';
  }
  const n = (wallet.buyers && wallet.buyers.length) || 0;
  return (
    `📂 *Existing Wallets*\n\n` +
    `*Wallet ${pageIndex + 1} / ${total}*\n\n` +
    `Address:\n\`${wallet.address}\`\n\n` +
    `Buyer bots: *${n}*\n\n` +
    `_Use as Main restores this wallet and its buyer bots._`
  );
}

/** One wallet per page. pageIndex is 0-based. */
function existingWalletsKeyboard(pageIndex, total) {
  const rows = [];
  if (total > 0) {
    rows.push([
      { text: '✅ Use as Main', callback_data: `ew_u_${pageIndex}` },
      { text: '🗑️ Delete', callback_data: `ew_d_${pageIndex}` }
    ]);
  }
  const nav = [];
  if (pageIndex > 0) nav.push({ text: '⬅️ Previous', callback_data: 'ew_prev' });
  if (pageIndex < total - 1) nav.push({ text: '➡️ Next', callback_data: 'ew_next' });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '🏠 Back', callback_data: 'ew_back' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function buyerSetupMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👥 Generate Buyer Wallets', callback_data: 'buyer_wallets' }],
        [{ text: '📂 Wallet Status', callback_data: 'wallet_status_setup' }]
      ]
    }
  };
}

function buyerOptionsMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '2 Wallets', callback_data: 'gen_2' },
          { text: '10 Wallets', callback_data: 'gen_10' }
        ],
        [
          { text: '🪙 20 Wallets (0.1 SOL)', callback_data: 'paid_20' },
          { text: '🪙 50 Wallets (0.5 SOL)', callback_data: 'paid_50' },
          { text: '🪙 100 Wallets (1 SOL)', callback_data: 'paid_100' }
        ]
      ]
    }
  };
}

function postBuyerMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔁 Transfer to Wallet', callback_data: 'transfer_main' }],
        [
          { text: '💸 Distribute SOL', callback_data: 'distribute_sol' },
          { text: '📂 Wallet Status', callback_data: 'wallet_status_post' }
        ],
        [{ text: '📊 Balances', callback_data: 'bot_balances' }],
        [{ text: '⚙️ Configure Trading', callback_data: 'action_menu' }]
      ]
    }
  };
}

function botSettingsPanel() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🗑️ Delete Bot Wallet', callback_data: 'delete_bot_wallet' },
          { text: '➕ Add Bot Wallet', callback_data: 'add_bot_wallet' }
        ],
        [{ text: '🏠 Back', callback_data: 'action_menu' }]
      ]
    }
  };
}

function actionMenu(session, bal = "0.000") {
  // 🔧 FIX: Use standardized 'address' property
  const walletAddr = session.mainWallet ? session.mainWallet.address : '';
  const hasToken = !!(session.tradeConfig && session.tradeConfig.contractAddress);

  const botWallets = (session.buyers || []).map((w, index) => ({
    id: `bot-${index}`,
    name: `Buyer ${index + 1}`,
    address: w.pub,
    balance: w.lastBalance || 0
  }));

  const encodedBots = Buffer.from(JSON.stringify(botWallets)).toString('base64');

  // 🔧 FIX: Use environment variable for WebApp URL
  const baseUrl = process.env.WEBAPP_URL || 'https://salably-nonconstruable-arnoldo.ngrok-free.dev';
  const webAppUrl = `${baseUrl}?wallet=${walletAddr}&balance=${bal}&bots=${encodedBots}`;

  const sellRow = hasToken
    ? [
        { text: '💥 Sell All', callback_data: 'sell_all' },
        { text: '📊 Token Balances', callback_data: 'token_balances' }
      ]
    : [{ text: '💥 Sell All', callback_data: 'sell_all' }];

  const tokenInfoRow = hasToken
    ? [[{ text: '💰 Token Info', callback_data: 'token_info' }]]
    : [];

  return {
    text: `⚙️ *Trade Dashboard*\n\nMain Wallet: \`${walletAddr}\`\nBalance: *${bal} SOL*\n\nConfigure your trading session below:`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: session.isTrading ? '🔴 Stop Trading' : '🟢 Start Trading', callback_data: 'trade_toggle' },
          { text: '⚙️ Bot Settings', callback_data: 'bot_settings' }
        ],
        [
          { text: '📬 Wallet Status', callback_data: 'wallet_status_trade' },
          { text: '📊 Bot Balances', callback_data: 'bot_balances_post' }
        ],
        [{ text: '🔁 Transfer to Wallet', callback_data: 'transfer_trade' }],
        [{ text: '⚙️ Trade Settings', callback_data: 'trade_settings' }],
        sellRow,
        ...tokenInfoRow,
        [{
          text: '🚀 Deploy Token',
          web_app: { url: webAppUrl }
        }]
      ]
    }
  };
}

function postBuyerActionMenu(session) {
  const hasToken = !!(session.tradeConfig && session.tradeConfig.contractAddress);
  const tokenRow = hasToken
    ? [[
        { text: '📊 Token Balances', callback_data: 'token_balances' },
        { text: '💰 Token Info', callback_data: 'token_info' }
      ]]
    : [];

  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: session.isTrading ? '🔴 Trading' : '🟢 Trading', callback_data: 'trade_toggle' },
          { text: '💥 Sell All', callback_data: 'sell_all' }
        ],
        ...tokenRow
      ]
    }
  };
}

function tradeSettingsMessage(session) {
  const tc = session.tradeConfig || {};
  const sl = tc.slippage ?? 5;
  const mn = tc.minBuy ?? 0.01;
  const mx = tc.maxBuy ?? 0.05;
  const tp = tc.takeProfitPercent ?? 20;
  const sp = tc.sellPortionPercent ?? 20;
  const ca = tc.contractAddress ? `\`${tc.contractAddress}\`` : '`—`';
  return (
    `⚙️ *Trade Settings*\n\n` +
    `*Contract:* ${ca}\n` +
    `*Slippage:* ${sl}%\n` +
    `*Min buy:* ${mn} SOL\n` +
    `*Max buy:* ${mx} SOL\n` +
    `*Sell %:* ${sp}%\n` +
    `*Take profit:* ${tp}%\n\n` +
    `_Tap a field below to edit._`
  );
}

function tradeSettingsPanel() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📉 Slippage', callback_data: 'ts_slippage' },
          { text: '⬇️ Min buy', callback_data: 'ts_min_buy' }
        ],
        [
          { text: '⬆️ Max buy', callback_data: 'ts_max_buy' }
        ],
        [
          { text: '📊 Sell %', callback_data: 'ts_sell_pct' },
          { text: '🎯 Take profit %', callback_data: 'ts_take_profit' }
        ],
        [{ text: '📍 Contract', callback_data: 'ts_contract' }],
        [{ text: '↩️ Back', callback_data: 'ts_back' }]
      ]
    }
  };
}

module.exports = {
  mainMenu,
  buyerSetupMenu,
  buyerOptionsMenu,
  postBuyerMenu,
  botSettingsPanel,
  actionMenu,
  postBuyerActionMenu,
  tradeSettingsMessage,
  tradeSettingsPanel,
  existingWalletsMessage,
  existingWalletsKeyboard
};
