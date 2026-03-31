const fs = require('fs').promises;
const path = require('path');

// Database file path
const DB_FILE = path.join(__dirname, '..', 'data', 'latestToken.json');

// Ensure data directory exists
async function ensureDataDir() {
  const dataDir = path.dirname(DB_FILE);
  try {
    await fs.access(dataDir);
  } catch {
    await fs.mkdir(dataDir, { recursive: true });
  }
}

// Save latest token (replaces old one)
async function saveLatestToken(tokenData) {
  await ensureDataDir();
  
  try {
    const latestToken = {
      ...tokenData,
      createdAt: new Date().toISOString()
    };
    
    // Save single token file (replaces old one)
    await fs.writeFile(DB_FILE, JSON.stringify(latestToken, null, 2));
    
    console.log(`✅ Latest token saved: ${tokenData.mintAddress}`);
    return latestToken;
    
  } catch (error) {
    console.error('❌ Error saving latest token:', error);
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
