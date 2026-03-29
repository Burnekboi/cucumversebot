const fs = require('fs');
const file = 'c:/Users/Christian Jake/OneDrive/Desktop/CUCUMVERSE-RUNNING/cucumber bot/helpers/solana.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Clean the manual create instructions section.
const startMarker = "console.log('🔧 Building MANUAL create instructions');".replace('MANUAL create instructions', 'MANUAL create instructions...');
const sIdx = content.indexOf(startMarker);
const endMarker = "console.log(`✅ Created ${createInstructions.length} manual create instructions`);";
const eIdx = content.indexOf(endMarker);

if (sIdx !== -1 && eIdx !== -1) {
    const before = content.substring(0, sIdx);
    const after = content.substring(eIdx + endMarker.length);
    const newText = `console.log('🔧 Building Create instructions from SDK...');
    
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
    content = before + newText + after;
    console.log("Replaced create instructions section.");
}

// 2. Clean the bondingCurveV2 additions to avoid duplication.
const fixMarker = "    // THE FIX: Define 13th account";
const fixIdx = content.indexOf(fixMarker);
if (fixIdx !== -1) {
    const restStr = content.substring(fixIdx);
    const buyIxIdx = restStr.indexOf("const buyIx =");
    if (buyIxIdx !== -1) {
        const beforeFix = content.substring(0, fixIdx);
        const afterFix = restStr.substring(buyIxIdx);
        const newFix = `    // THE FIX: Define 13th and 14th accounts
    const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], PUMP_PROGRAM);
    const [bondingCurveV2] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve-v2'), mintKeypair.publicKey.toBuffer()], PUMP_PROGRAM);

    console.log(\`🔧 Bonding Curve: \${bondingCurve.toString()}\`);
    console.log(\`🔧 Global Volume Accumulator: \${globalVolumeAccumulator.toString()}\`);
    console.log(\`🔧 Bonding Curve V2: \${bondingCurveV2.toString()}\`);

    `;
        content = beforeFix + newFix + afterFix;
        console.log("Cleaned atomic buyIx fallback section.");
    }
}

fs.writeFileSync(file, content, 'utf8');
console.log("Done");
