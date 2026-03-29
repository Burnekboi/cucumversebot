const fs = require('fs');
const file = 'helpers/solana.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Replace manual create block
const startText = "// 1. Get standard Create instructions\\n    console.log('🔧 Building MANUAL create instructions...');";
const endText = "console.log(`✅ Created ${createInstructions.length} manual create instructions`);";

const startIndex = content.indexOf(startText);
const endIndex = content.indexOf(endText);

if (startIndex !== -1 && endIndex !== -1) {
    const before = content.substring(0, startIndex);
    const after = content.substring(endIndex + endText.length);
    
    const newBlock = `// 1. Get standard Create instructions
    console.log('🔧 Building Create instructions from SDK...');
    
    if (!mintKeypair || !mintKeypair.publicKey) {
      throw new Error('mintKeypair is not properly initialized');
    }
    
    console.log('🔑 Mint Keypair:', mintKeypair.publicKey.toString());
    
    const createTx = await sdk.getCreateInstructions(
      mainKeypair.publicKey,
      tokenName,
      symbol,
      "https://ipfs.io/ipfs/" + metadataUri.split("/").pop(),
      mintKeypair
    );
    const createInstructions = createTx.instructions;
    
    // Compute budget instructions
    createInstructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1500000 }));
    createInstructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }));
    
    console.log(\`✅ Extracted \${createInstructions.length} create instructions from SDK\`);`;
    
    content = before + newBlock + after;
}

// 2. Patch remainingAccounts
content = content.replace(
    /({ pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true })(\s*\])/g,
    `$1,
        { pubkey: bondingCurveV2, isSigner: false, isWritable: true }$2`
);

// We need to define bondingCurveV2 before it's used
// Inside atomic jito buyIx:
content = content.replace(
    "const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], PUMP_PROGRAM);",
    `const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], PUMP_PROGRAM);
    const [bondingCurveV2] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve-v2'), mintKeypair.publicKey.toBuffer()], PUMP_PROGRAM);`
);

// Inside buildBuyInstruction:
content = content.replace(
    /const \[globalVolumeAccumulator\] = PublicKey\.findProgramAddressSync\(\s*\[Buffer\.from\('global_volume_accumulator'\)\],\s*PUMP_PROGRAM\s*\);/,
    `const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], PUMP_PROGRAM);
          const [bondingCurveV2] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve-v2'), typeof mint === 'string' ? new PublicKey(mint).toBuffer() : mint.toBuffer()], PUMP_PROGRAM);`
);

// Inside sellTokenAmount:
content = content.replace(
    /const \[globalVolumeAccumulator\] = PublicKey\.findProgramAddressSync\(\s*\[Buffer\.from\('global_volume_accumulator'\)\],\s*PUMP_PROGRAM\s*\);/,
    `const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], PUMP_PROGRAM);
          const [bondingCurveV2] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve-v2'), new PublicKey(contractAddress).toBuffer()], PUMP_PROGRAM);`
);

fs.writeFileSync(file, content, 'utf8');
console.log('✅ File successfully patched by script!');
