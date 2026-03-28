const { Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction } = require('@solana/web3.js');
const { AnchorProvider } = require('@coral-xyz/anchor');
const { PumpFunSDK } = require('pumpdotfun-sdk');

const { base58Decode } = require('../utils/base58');
const {
  getBalance,
  getTokenBalance,
  fetchTokenPriceInSol,
  sellTokenAmount
} = require('./solana');

function makeWallet(keypair) {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx) => { tx.sign([keypair]); return tx; },
    signAllTransactions: async (txs) => { txs.forEach(tx => tx.sign([keypair])); return txs; }
  };
}

async function buildAndSendTx(connection, instructions, payer, signers, priorityFees) {
  const { buildVersionedTx } = require('pumpdotfun-sdk/dist/cjs/util');
  const tx = new Transaction();
  if (priorityFees) {
    const { ComputeBudgetProgram } = require('@solana/web3.js');
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: priorityFees.unitLimit }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFees.unitPrice }));
  }
  instructions.forEach(ix => tx.add(ix));
  const vTx = await buildVersionedTx(connection, payer, tx, 'confirmed');
  vTx.sign(signers);
  const sig = await connection.sendTransaction(vTx, { skipPreflight: false });
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
  return sig;
}

// ---------------- MAIN TRADING ----------------
async function performRealTrading(bot, connection, session, chatId) {
  const { contractAddress, minBuy, maxBuy, slippage } = session.tradeConfig;

  if (!contractAddress) {
    await bot.sendMessage(chatId, '❌ Contract address not set.');
    return;
  }

  session.liveLogs = [];
  session.isTrading = true;

  const batchSize = 5;

  for (let i = 0; i < session.buyers.length; i += batchSize) {
    if (!session.isTrading) break;

    const batch = session.buyers.slice(i, i + batchSize);

    await Promise.all(batch.map(async (buyer, index) => {
      const walletIndex = i + index;

      let success = false;
      let attempts = 0;
      const maxRetries = 3;

      const logEntry = {
        walletNum: walletIndex + 1,
        status: 'processing',
        message: `⏳ Wallet #${walletIndex + 1}: Checking balance...`
      };

      session.liveLogs.push(logEntry);

      while (attempts < maxRetries && !success) {
        try {
          const solBalance = await getBalance(connection, buyer.pub);
          const feeBuffer = 0.005;

          if (solBalance <= minBuy + feeBuffer) {
            logEntry.status = 'failed';
            logEntry.message = `wallet ${walletIndex + 1} (not enough SOL)`;
            return;
          }

          const buyAmount = Math.random() * (maxBuy - minBuy) + minBuy;

          if (buyAmount > solBalance - feeBuffer) {
            logEntry.status = 'failed';
            logEntry.message = `wallet ${walletIndex + 1} (insufficient for buy)`;
            return;
          }

          logEntry.message = `🔄 Wallet #${walletIndex + 1}: Attempt ${attempts + 1}`;

          const beforeBalance = await getTokenBalance(connection, buyer.pub, contractAddress);

          // Use pumpdotfun-sdk directly via instruction builder
          const buyerKeypair = Keypair.fromSecretKey(base58Decode(buyer.priv));
          const provider     = new AnchorProvider(connection, makeWallet(buyerKeypair), { commitment: 'confirmed' });
          const sdk          = new PumpFunSDK(provider);

          const buyLamports = BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL));

          const buyTx = await sdk.getBuyInstructionsBySolAmount(
            buyerKeypair.publicKey,
            new PublicKey(contractAddress),
            buyLamports,
            500n // 5% slippage
          );

          const sig = await buildAndSendTx(
            connection,
            buyTx.instructions,
            buyerKeypair.publicKey,
            [buyerKeypair],
            { unitLimit: 250000, unitPrice: 250000 }
          );

          const afterBalance = await getTokenBalance(connection, buyer.pub, contractAddress);

          if (afterBalance <= beforeBalance) {
            throw new Error("No tokens received");
          }

          // SUCCESS
          const tokenReceived = afterBalance - beforeBalance;
          const solLeft = await getBalance(connection, buyer.pub);

          logEntry.status = 'success';
          logEntry.solBought = buyAmount.toFixed(4);
          logEntry.tokenAmount = tokenReceived.toFixed(2);
          logEntry.solBal = solLeft.toFixed(4);
          logEntry.message = `✅ Wallet #${walletIndex + 1} Success`;

          buyer.trade = {
            entryPricePerToken: buyAmount / tokenReceived,
            entrySol: buyAmount
          };

          success = true;

        } catch (err) {
          attempts++;
          console.log(`Buy error wallet ${walletIndex + 1}:`, err.message);

          if (attempts >= maxRetries) {
            logEntry.status = 'failed';
            logEntry.message = `wallet ${walletIndex + 1} (max retries reached)`;
          } else {
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }
    }));

    await new Promise(r => setTimeout(r, 1500));
  }

  startSellMonitor(bot, connection, session, chatId);
}

// ---------------- SELL MONITOR ----------------
async function startSellMonitor(bot, connection, session, chatId) {
  const {
    takeProfitPercent,
    sellPortionPercent,
    contractAddress
  } = session.tradeConfig;

  if (session.sellInterval) {
    clearInterval(session.sellInterval);
  }

  session.sellInterval = setInterval(async () => {
    if (!session.isTrading) {
      clearInterval(session.sellInterval);
      return;
    }

    for (let i = 0; i < session.buyers.length; i++) {
      const buyer = session.buyers[i];

      try {
        if (!buyer.trade) continue;

        const tokenBalance = await getTokenBalance(connection, buyer.pub, contractAddress);
        if (!tokenBalance || tokenBalance <= 0) continue;

        const currentPrice = await fetchTokenPriceInSol(contractAddress);
        if (!currentPrice) continue;

        const targetPrice =
          buyer.trade.entryPricePerToken *
          (1 + takeProfitPercent / 100);

        if (currentPrice >= targetPrice) {
          const sellAmount = tokenBalance * (sellPortionPercent / 100);

          const solReceived = await sellTokenAmount(
            bot,
            connection,
            buyer,
            sellAmount,
            contractAddress,
            chatId,
            i
          );

          const solLeft = await getBalance(connection, buyer.pub);

          session.liveLogs.push({
            walletNum: i + 1,
            status: 'success',
            isSell: true,
            solBought: solReceived?.toFixed(4) || "0",
            tokenAmount: sellAmount.toFixed(2),
            solBal: solLeft.toFixed(4),
            message: `💰 Wallet #${i + 1} TOOK PROFIT!`
          });

          buyer.trade.entryPricePerToken *= (1 - sellPortionPercent / 100);
        }

      } catch (err) {
        console.log("Sell monitor error:", err.message);
      }
    }
  }, 5000);
}

// ---------------- STOP TRADING ----------------
async function stopAllTrading(session) {
  session.isTrading = false;

  if (session.sellInterval) {
    clearInterval(session.sellInterval);
    session.sellInterval = null;
  }

  session.liveLogs.push({
    status: 'failed',
    message: "🛑 TRADING HALTED BY USER"
  });
}

// ---------------- SELL ALL ----------------
async function sellAllTokens(bot, connection, session, chatId) {
  await stopAllTrading(session);

  session.liveLogs.push({
    status: 'processing',
    message: "🚨 SELL ALL INITIATED..."
  });

  const { contractAddress } = session.tradeConfig;

  await Promise.all(session.buyers.map(async (buyer, i) => {
    try {
      const tokenBalance = await getTokenBalance(connection, buyer.pub, contractAddress);

      if (tokenBalance > 0) {
        await sellTokenAmount(
          bot,
          connection,
          buyer,
          tokenBalance,
          contractAddress,
          chatId,
          i
        );

        session.liveLogs.push({
          walletNum: i + 1,
          status: 'success',
          isSell: true,
          message: `💥 Wallet #${i + 1} FULL DUMP COMPLETE`
        });
      }

    } catch (err) {
      console.error(`Sell All Error Wallet ${i + 1}:`, err.message);
    }
  }));
}

// ---------------- EXPORTS ----------------
module.exports = {
  performRealTrading,
  startSellMonitor,
  stopAllTrading,
  sellAllTokens
};
