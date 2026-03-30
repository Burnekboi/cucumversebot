const { Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');
const { base58Decode } = require('../utils/base58');
const {
  getBalance,
  getTokenBalance,
  fetchTokenPriceInSol,
  sellTokenAmount,
  buildBuyInstruction,
  getBondingCurveData,
  calcBuyTokens,
  sendTx
} = require('./solana');

// ---------------- MAIN TRADING ----------------
async function performRealTrading(bot, connection, session, chatId) {
  const { contractAddress, minBuy, maxBuy, slippage } = session.tradeConfig;
  const jitoBundleEnabled = session.jitoBundle || false;

  if (!contractAddress) {
    await bot.sendMessage(chatId, '❌ Contract address not set.');
    return;
  }

  console.log(`🤖 Starting PARALLEL bot wallet trading for ${contractAddress}`);
  console.log(`📊 Config: minBuy=${minBuy}, maxBuy=${maxBuy}, slippage=${slippage}`);
  console.log(`👥 Active bots: ${session.buyers?.length || 0}`);

  session.liveLogs = [];
  session.isTrading = true;

  // CRITICAL: Verify this is a valid pump.fun token before trading
  console.log(`🔍 Verifying ${contractAddress} is a valid pump.fun token...`);
  let isValidPumpFunToken = false;
  
  try {
    const bondingCurveData = await getBondingCurveData(connection, new PublicKey(contractAddress));
    if (bondingCurveData && bondingCurveData.virtualSolReserves && bondingCurveData.virtualTokenReserves) {
      isValidPumpFunToken = true;
      console.log(`✅ Valid pump.fun token - SOL reserves: ${bondingCurveData.virtualSolReserves}, Token reserves: ${bondingCurveData.virtualTokenReserves}`);
    } else {
      console.log(`❌ Invalid pump.fun token - bonding curve not found`);
      session.liveLogs.push({ 
        status: 'error', 
        message: `❌ ${contractAddress} is not a valid pump.fun token. Bonding curve not found.` 
      });
      session.isTrading = false;
      return;
    }
  } catch (verifyErr) {
    console.error(`❌ Error verifying pump.fun token: ${verifyErr.message}`);
    session.liveLogs.push({ 
      status: 'error', 
      message: `❌ Failed to verify ${contractAddress} as pump.fun token: ${verifyErr.message}` 
    });
    session.isTrading = false;
    return;
  }

  // Check if there are bot wallets
  if (!session.buyers || session.buyers.length === 0) {
    session.liveLogs.push({ status: 'warning', message: 'No bot wallets configured' });
    session.isTrading = false;
    return;
  }

  // Add initial trading message
  session.liveLogs.push({ 
    status: 'processing', 
    message: `🚀 Initiating PARALLEL bot wallet buying for verified pump.fun token...` 
  });

  let successfulBuys = 0;
  let failedBuys = 0;

  // PARALLEL EXECUTION - All bots buy at once
  console.log(`🔄 Starting parallel execution of ${session.buyers.length} bots`);

  await Promise.all(session.buyers.map(async (buyer, walletIndex) => {
    let success = false;
    let attempts = 0;
    const maxRetries = 3;

    const logEntry = {
      walletNum: walletIndex + 1,
      status: 'processing',
      message: `⏳ Bot #${walletIndex + 1}: Checking balance...`
    };

    session.liveLogs.push(logEntry);

    while (attempts < maxRetries && !success) {
      try {
        console.log(`🔍 Bot #${walletIndex + 1} - Attempt ${attempts + 1}/${maxRetries}`);
        
        // Use trading connection for better rate limiting
        const tradingConnection = require('../app').getTradingConnection();
        
        const solBalance = await getBalance(tradingConnection, buyer.pub);
        const feeBuffer = 0.005;

        console.log(`💰 Bot #${walletIndex + 1} balance: ${solBalance.toFixed(4)} SOL`);

        if (solBalance <= minBuy + feeBuffer) {
          logEntry.status = 'failed';
          logEntry.message = `Bot #${walletIndex + 1}: Insufficient SOL (${solBalance.toFixed(4)} < ${(minBuy + feeBuffer).toFixed(4)})`;
          failedBuys++;
          return;
        }

        const buyAmount = Math.random() * (maxBuy - minBuy) + minBuy;

        if (buyAmount > solBalance - feeBuffer) {
          logEntry.status = 'failed';
          logEntry.message = `Bot #${walletIndex + 1}: Insufficient for buy (${buyAmount.toFixed(4)} > ${(solBalance - feeBuffer).toFixed(4)})`;
          failedBuys++;
          return;
        }

        logEntry.message = `🔄 Bot #${walletIndex + 1}: Buying ${buyAmount.toFixed(4)} SOL (Attempt ${attempts + 1})`;

        const beforeBalance = await getTokenBalance(tradingConnection, buyer.pub, contractAddress);
        console.log(`📊 Bot #${walletIndex + 1} before balance: ${beforeBalance} tokens`);

        const buyerKeypair = Keypair.fromSecretKey(base58Decode(buyer.priv));
        const mint         = new PublicKey(contractAddress);
        const buyLamports  = BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL));

        // Get current bonding curve state for accurate token amount
        const bondingCurveData = await getBondingCurveData(tradingConnection, mint);
        if (!bondingCurveData || !bondingCurveData.virtualSolReserves) {
          throw new Error('Could not fetch bonding curve data');
        }

        const { virtualSolReserves, virtualTokenReserves } = bondingCurveData;
        const tokenAmt   = calcBuyTokens(buyLamports, virtualSolReserves, virtualTokenReserves);
        const maxSolCost = buyLamports * 110n / 100n; // 10% slippage

        console.log(`🎯 Bot #${walletIndex + 1} buying ${tokenAmt} tokens for ${buyAmount.toFixed(4)} SOL`);

        const buyTx = await buildBuyInstruction(tradingConnection, buyerKeypair.publicKey, mint, tokenAmt, maxSolCost);

        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250000 }));
        
        // Add all instructions from buyTx (not just the buy instruction)
        if (buyTx.instructions) {
          buyTx.instructions.forEach(ix => tx.add(ix));
        } else {
          tx.add(buyTx);
        }

        console.log(`📤 Bot #${walletIndex + 1} sending transaction...`);
        const sig = await sendTx(tradingConnection, tx, [buyerKeypair]);
        console.log(`✅ Bot #${walletIndex + 1} TX sent: https://solscan.io/tx/${sig}`);

        // CRITICAL: Verify buy actually worked
        console.log(`🔍 Bot #${walletIndex + 1} verifying purchase...`);
        await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for confirmation

        const afterBalance = await getTokenBalance(tradingConnection, buyer.pub, contractAddress);
        console.log(`📊 Bot #${walletIndex + 1} after balance: ${afterBalance} tokens`);

        if (afterBalance <= beforeBalance) {
          throw new Error(`No tokens received. Before: ${beforeBalance}, After: ${afterBalance}`);
        }

        // SUCCESS
        const tokenReceived = afterBalance - beforeBalance;
        const solLeft = await getBalance(tradingConnection, buyer.pub);

        console.log(`🎉 Bot #${walletIndex + 1} SUCCESS: ${tokenReceived} tokens for ${buyAmount.toFixed(4)} SOL`);

        logEntry.status = 'success';
        logEntry.solBought = buyAmount.toFixed(4);
        logEntry.tokenAmount = tokenReceived.toFixed(2);
        logEntry.solBal = solLeft.toFixed(4);
        logEntry.message = `🤖 Bot #${walletIndex + 1}\n  💰 ${buyAmount.toFixed(4)} SOL\n  🪙 ${tokenReceived.toFixed(2)} tokens\n  🔗 ${sig.slice(0, 16)}...`;

        buyer.trade = {
          entryPricePerToken: buyAmount / tokenReceived,
          entrySol: buyAmount
        };

        success = true;
        successfulBuys++;

      } catch (err) {
        attempts++;
        console.error(`❌ Buy error bot ${walletIndex + 1}:`, err.message);

        if (attempts >= maxRetries) {
          logEntry.status = 'failed';
          logEntry.message = `❌ Bot #${walletIndex + 1}: ${err.message}`;
          failedBuys++;
        } else {
          logEntry.message = `🔄 Bot #${walletIndex + 1}: Retrying... (${attempts}/${maxRetries})`;
          await new Promise(r => setTimeout(r, 2000)); // Wait between retries
        }
      }
    }
  }));

  // Summary
  console.log(`📊 Parallel bot trading summary: ${successfulBuys} successful, ${failedBuys} failed`);
  session.liveLogs.push({ 
    status: 'completed', 
    message: `🚀 Parallel bot swarm completed: ${successfulBuys} successful, ${failedBuys} failed` 
  });

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
