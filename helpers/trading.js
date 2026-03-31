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
  sendTx,
  executeHybridBatchBuying
} = require('./solana');

// ---------------- MAIN TRADING ----------------
async function performRealTrading(bot, connection, session, chatId) {
  const { contractAddress, minBuy, maxBuy, slippage } = session.tradeConfig;

  if (!contractAddress) {
    await bot.sendMessage(chatId, '❌ Contract address not set.');
    return;
  }

  console.log(`🤖 Starting HYBRID BATCH bot wallet trading for ${contractAddress}`);
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
    message: `🚀 Initiating HYBRID BATCH bot wallet buying (10 per second, 1.5s interval)...` 
  });

  // Execute hybrid batch buying
  const { totalSuccess, totalFailed } = await executeHybridBatchBuying(
    bot, connection, session, chatId, contractAddress, session.buyers
  );

  // Summary
  console.log(`📊 Hybrid batch trading summary: ${totalSuccess} successful, ${totalFailed} failed`);
  session.liveLogs.push({ 
    status: 'completed', 
    message: `🚀 Hybrid batch swarm completed: ${totalSuccess} successful, ${totalFailed} failed` 
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

  // Show trade panel after stopping
  session.showTradePanel = true;
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

// ---------------- DEV SELL ----------------
async function sellDevTokens(bot, connection, session, chatId, sellPercent = 100) {
  if (!session.mainWallet || !session.mainWallet.priv) {
    await bot.sendMessage(chatId, '❌ Dev wallet not configured');
    return;
  }

  const { contractAddress } = session.tradeConfig;
  if (!contractAddress) {
    await bot.sendMessage(chatId, '❌ No token contract address set');
    return;
  }

  const devKeypair = Keypair.fromSecretKey(base58Decode(session.mainWallet.priv));
  
  try {
    // Get current token balance
    const tokenBalance = await getTokenBalance(connection, devKeypair.publicKey, contractAddress);
    
    if (tokenBalance <= 0) {
      await bot.sendMessage(chatId, '❌ Dev wallet has no tokens to sell');
      return;
    }

    // Calculate sell amount based on percentage
    let sellAmount;
    if (sellPercent === 100) {
      sellAmount = tokenBalance; // Sell all
    } else {
      sellAmount = tokenBalance * (sellPercent / 100); // Sell percentage
    }

    console.log(`🔥 Dev selling ${sellAmount} tokens (${sellPercent}% of ${tokenBalance})`);

    session.liveLogs.push({
      status: 'processing',
      message: `🔥 Dev wallet selling ${sellPercent}% (${sellAmount.toFixed(2)} tokens)...`
    });

    // Execute sell
    const solReceived = await sellTokenAmount(
      bot,
      connection,
      { pub: devKeypair.publicKey, priv: session.mainWallet.priv },
      sellAmount,
      contractAddress,
      chatId,
      'DEV'
    );

    const remainingBalance = await getTokenBalance(connection, devKeypair.publicKey, contractAddress);
    const solBalance = await getBalance(connection, devKeypair.publicKey);

    session.liveLogs.push({
      status: 'success',
      message: `💰 Dev wallet sold ${sellAmount.toFixed(2)} tokens → ${solReceived?.toFixed(4) || '0'} SOL`
    });

    session.liveLogs.push({
      status: 'success', 
      message: `📊 Remaining: ${remainingBalance.toFixed(2)} tokens | SOL: ${solBalance.toFixed(4)}`
    });

    await bot.sendMessage(
      chatId,
      `✅ *Dev Sell Complete!*\n\n` +
      `💰 Sold: ${sellAmount.toFixed(2)} tokens (${sellPercent}%)\n` +
      `💸 Received: ${solReceived?.toFixed(4) || '0'} SOL\n` +
      `📊 Remaining: ${remainingBalance.toFixed(2)} tokens\n` +
      `💵 SOL Balance: ${solBalance.toFixed(4)}`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('❌ Dev sell error:', error);
    session.liveLogs.push({
      status: 'error',
      message: `❌ Dev sell failed: ${error.message}`
    });
    await bot.sendMessage(chatId, `❌ Dev sell failed: ${error.message}`);
  }
}

// Handle custom sell percentage input
async function handleCustomDevSell(bot, connection, session, chatId) {
  await bot.sendMessage(
    chatId,
    `🔢 *Enter sell percentage (1-99):*\n\n` +
    `Please enter a number between 1 and 99 for the percentage of tokens to sell.\n` +
    `Example: 50 (to sell 50% of tokens)`,
    { parse_mode: 'Markdown' }
  );

  // Set up input handler
  session.pendingInput = {
    resolve: async (input) => {
      const percent = parseInt(input);
      
      if (isNaN(percent) || percent < 1 || percent > 99) {
        await bot.sendMessage(chatId, '❌ Invalid percentage. Please enter a number between 1 and 99.');
        return;
      }

      await sellDevTokens(bot, connection, session, chatId, percent);
    }
  };
}

// ---------------- EXPORTS ----------------
module.exports = {
  performRealTrading,
  startSellMonitor,
  stopAllTrading,
  sellAllTokens,
  sellDevTokens,
  handleCustomDevSell
};
