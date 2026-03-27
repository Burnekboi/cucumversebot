const User = require('./helpers/User');
const {
  normalizeBuyer,
  normalizeStoredWallets,
  MAX_STORED_WALLETS
} = require('./helpers/walletStorage');
const sessions = {};

function createSession(chatId) {
  const idStr = chatId.toString();
  sessions[idStr] = {
    mainWallet: { address: null, priv: null },
    storedWallets: [],
    buyers: [],
    tradeConfig: {
      slippage: 5,
      minBuy: 0.01,
      maxBuy: 0.05,
      contractAddress: null,
      takeProfitPercent: 20,
      sellPortionPercent: 20
    },
    isTrading: false,
    pendingInput: null,
    uiMessageId: null,
    existingWalletPage: 0
  };
  return sessions[idStr];
}

async function getSession(chatId) {
  const idStr = chatId.toString();

  // 1. Basic initialization
  if (!sessions[idStr]) createSession(idStr);
  const session = sessions[idStr];

  // 2. 🛡️ THE INPUT SHIELD
  // If we are waiting for a Private Key, do NOT let the DB touch the session.
  if (session.pendingInput) return session;

  // 3. 🛡️ THE RAM SHIELD
  // If the wallet is already in RAM (just imported/created), skip the DB sync.
  // This prevents the "DB wipe" race condition.
  if (session.mainWallet && session.mainWallet.priv && session.mainWallet.address) {
    return session;
  }

  try {
    const user = await User.findOne({ telegramId: idStr });

    if (user) {
      const dbStored = user.storedWallets || [];
      const dbActive = user.mainWallet || {};
      const dbBuyers = user.buyers || [];

      if (dbStored.length === 0) {
        // If DB is totally empty, reset RAM
        session.mainWallet = { address: null, priv: null };
        session.storedWallets = [];
        session.buyers = [];

        // Clean up any ghost pointers in the DB
        if (dbActive.address || dbActive.publicKey) {
          await User.updateOne(
            { telegramId: idStr },
            { $set: { mainWallet: { address: null, priv: null }, buyers: [] } }
          );
        }
      } else {
        // 4. STANDARDIZED MAPPING
        // This ensures that no matter what the DB calls it, the RAM gets 'address' and 'priv'
        const normalizedActive = {
          address: dbActive.address || dbActive.publicKey || null,
          priv: dbActive.priv || dbActive.privateKey || null
        };

        // Validate if the active wallet still exists in the stored list
        const isActiveValid = dbStored.some(w => (w.address || w.publicKey) === normalizedActive.address);

        session.mainWallet = isActiveValid ? normalizedActive : dbStored[0];
        const mainAddr = session.mainWallet?.address || session.mainWallet?.publicKey;
        const list = normalizeStoredWallets(dbStored, dbBuyers, mainAddr);
        session.storedWallets = list;

        const entry = list.find((x) => x.address === mainAddr);
        if (entry && entry.buyers && entry.buyers.length) {
          session.buyers = entry.buyers.map((buyer) => ({
            pub: buyer.pub || buyer.address,
            priv: buyer.priv || buyer.privateKey,
            lastBalance: buyer.lastBalance || 0
          }));
        } else {
          session.buyers = dbBuyers.map((buyer) => ({
            pub: buyer.pub || buyer.address,
            priv: buyer.priv || buyer.privateKey,
            lastBalance: buyer.lastBalance || 0
          }));
        }
      }

      if (user.tradeConfig && typeof user.tradeConfig === 'object') {
        const u = user.tradeConfig.toObject ? user.tradeConfig.toObject() : user.tradeConfig;
        session.tradeConfig = { ...session.tradeConfig, ...u };
      }

      console.log(`✅ [DB Sync] Restored session for ${idStr} | Buyers: ${session.buyers.length}`);
    }
  } catch (err) {
    console.error("❌ Recovery Error:", err.message);
  }

  return session;
}

/**
 * 💾 Save buyers array to MongoDB
 * Call this after generating or modifying buyer wallets
 */
async function saveBuyersToDb(chatId, buyers) {
  try {
    const idStr = chatId.toString();
    const u = await User.findOne({ telegramId: idStr });
    const mainAddr = u?.mainWallet?.address || u?.mainWallet?.publicKey;
    const priv = u?.mainWallet?.priv || u?.mainWallet?.privateKey;
    const list = normalizeStoredWallets(u?.storedWallets || [], u?.buyers || [], mainAddr);
    const nb = (buyers || []).map(normalizeBuyer).filter(Boolean);
    const idx = list.findIndex((x) => x.address === mainAddr);
    if (idx >= 0) {
      list[idx] = { ...list[idx], buyers: nb };
    } else if (mainAddr && priv && list.length < MAX_STORED_WALLETS) {
      list.push({ address: mainAddr, priv, buyers: nb });
    }
    await User.findOneAndUpdate(
      { telegramId: idStr },
      { $set: { buyers: nb, storedWallets: list } },
      { upsert: true }
    );
    console.log(`✅ [DB Save] Saved ${nb.length} buyers for ${idStr}`);
  } catch (err) {
    console.error("❌ Save Buyers Error:", err.message);
  }
}

async function saveTradeConfigToDb(chatId, tradeConfig) {
  try {
    if (!tradeConfig) return;
    const idStr = chatId.toString();
    // Don't persist contractAddress — it's session-only
    const { contractAddress, ...configToSave } = tradeConfig;
    await User.findOneAndUpdate(
      { telegramId: idStr },
      { $set: { tradeConfig: configToSave } },
      { upsert: true }
    );
    console.log(`✅ [DB Save] tradeConfig for ${idStr}`);
  } catch (err) {
    console.error("❌ Save tradeConfig Error:", err.message);
  }
}

module.exports = { sessions, createSession, getSession, saveBuyersToDb, saveTradeConfigToDb };
