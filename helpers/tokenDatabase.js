const fs = require('fs').promises;
const path = require('path');
const mongoose = require('mongoose');

// Database file path
const DB_FILE = path.join(__dirname, '..', 'data', 'latestToken.json');

// Shared Mongoose model -- same collection the airdrop bot reads
const DeployedToken = mongoose.models.DeployedToken ||
  mongoose.model('DeployedToken', new mongoose.Schema({
    chatId:        { type: Number, required: true, index: true },
    mintAddress:   { type: String },
    symbol:        { type: String },
    tokenName:     { type: String },
    deploymentSig: { type: String },
    createdAt:     { type: Date, default: Date.now }
  }));

// Ensure data directory exists
async function ensureDataDir() {
  const dataDir = path.dirname(DB_FILE);
  try {
    await fs.access(dataDir);
  } catch {
    await fs.mkdir(dataDir, { recursive: true });
  }
}

// Save latest token -- writes to JSON file + upserts into shared MongoDB
async function saveLatestToken(tokenData) {
  await ensureDataDir();

  try {
    const latestToken = {
      ...tokenData,
      createdAt: new Date().toISOString()
    };

    // Existing behaviour: save to JSON file
    await fs.writeFile(DB_FILE, JSON.stringify(latestToken, null, 2));
    console.log('Latest token saved: ' + tokenData.mintAddress);

    // Also write to shared MongoDB so the airdrop bot can verify deployment
    if (tokenData.chatId) {
      await DeployedToken.findOneAndUpdate(
        { chatId: Number(tokenData.chatId) },
        {
          chatId:        Number(tokenData.chatId),
          mintAddress:   tokenData.mintAddress,
          symbol:        tokenData.symbol        || null,
          tokenName:     tokenData.tokenName     || null,
          deploymentSig: tokenData.deploymentSig || null,
          createdAt:     new Date()
        },
        { upsert: true, new: true }
      );
      console.log('DeployedToken record saved for chatId ' + tokenData.chatId);
    }

    return latestToken;

  } catch (error) {
    console.error('Error saving latest token:', error);
    throw error;
  }
}

// Get latest token
async function getLatestToken() {
  await ensureDataDir();

  try {
    const data = await fs.readFile(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return null;
  }
}

module.exports = {
  saveLatestToken,
  getLatestToken
};
