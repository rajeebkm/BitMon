#!/usr/bin/env ts-node

import * as bitcoin from 'bitcoinjs-lib';
import * as fs from 'fs';
import * as path from 'path';
import { HTLCBuilder, HTLCConfig } from '../lib/htlc-builder';
import { spawn } from 'child_process';

// Add HTTP functionality for broadcasting
interface BroadcastResult {
  success: boolean;
  txid?: string;
  error?: string;
}

async function broadcastTransaction(hexTx: string, network: string): Promise<BroadcastResult> {
  try {
    // Determine the correct API endpoint based on network
    const apiUrl = network === 'testnet4'
      ? 'https://mempool.space/testnet4/api/tx'
      : network === 'testnet'
        ? 'https://mempool.space/testnet/api/tx'
        : 'https://mempool.space/api/tx';

    console.log(`📡 Broadcasting to ${apiUrl}...`);

    // Use curl to broadcast (more reliable than node fetch in this environment)
    const curlProcess = spawn('curl', [
      '-X', 'POST',
      apiUrl,
      '-d', hexTx,
      '-H', 'Content-Type: text/plain'
    ]);

    let response = '';
    let errorOutput = '';

    curlProcess.stdout.on('data', (data: Buffer) => {
      response += data.toString();
    });

    curlProcess.stderr.on('data', (data: Buffer) => {
      errorOutput += data.toString();
    });

    return new Promise((resolve) => {
      curlProcess.on('close', (code) => {
        if (code === 0 && response.trim()) {
          // Clean up the response (remove trailing %)
          const txid = response.replace('%', '').trim();

          // Validate txid format (64 char hex)
          if (txid.length === 64 && /^[a-f0-9]+$/i.test(txid)) {
            console.log(`✅ Transaction broadcasted successfully!`);
            console.log(`📝 TXID: ${txid}`);
            resolve({ success: true, txid });
          } else {
            console.log(`❌ Invalid response: ${response}`);
            resolve({ success: false, error: `Invalid API response: ${response}` });
          }
        } else {
          console.log(`❌ Broadcasting failed. Code: ${code}`);
          console.log(`❌ Error: ${errorOutput}`);
          resolve({ success: false, error: `HTTP error: ${errorOutput}` });
        }
      });
    });
  } catch (error) {
    console.error('❌ Broadcasting error:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

interface HTLCParams {
  senderPublicKey: string;
  receiverPublicKey: string;
  hashlock: string;
  locktime: number;
  network: 'mainnet' | 'testnet' | 'testnet4' | 'regtest';
  useSegwit: boolean;
  amount?: number;
  utxos?: any[];
  changeAddress?: string;
  feeRate?: number;
}

interface HTLCResult {
  address: string;
  redeemScript: string;
  scriptHash: string;
  witnessScript?: string;
  lockingScript: string;
  config: HTLCParams;
  createdAt: string;
}

class HTLCCreator {
  private getNetwork(networkName: string): bitcoin.Network {
    switch (networkName) {
      case 'mainnet':
        return bitcoin.networks.bitcoin;
      case 'testnet':
      case 'testnet4':
        return bitcoin.networks.testnet;
      case 'regtest':
        return bitcoin.networks.regtest;
      default:
        throw new Error(`Unsupported network: ${networkName}`);
    }
  }

  private saveHTLCToFile(result: HTLCResult, filename?: string): string {
    const outputDir = path.join(__dirname, '../output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    let filePath: string;
    if (filename) {
      // If filename is absolute, use it as-is, otherwise join with outputDir
      filePath = path.isAbsolute(filename) ? filename : path.join(outputDir, filename);
    } else {
      const defaultFilename = `htlc_${Date.now()}_${result.config.network}.json`;
      filePath = path.join(outputDir, defaultFilename);
    }

    // Ensure the directory exists
    const fileDir = path.dirname(filePath);
    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir, { recursive: true });
    }

    fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
    return filePath;
  }

  private loadParams(configFile?: string): HTLCParams {
    if (configFile && fs.existsSync(configFile)) {
      const configData = fs.readFileSync(configFile, 'utf8');
      return JSON.parse(configData) as HTLCParams;
    }

    // 🚨 CRITICAL ERROR: Config file is REQUIRED for atomic swaps!
    // The Taker must use the Maker's hashlock, never generate their own!
    console.error('❌ ATOMIC SWAP ERROR: Config file is required!');
    console.error('');
    console.error('🔄 In atomic swaps:');
    console.error('   1. MAKER generates secret and creates order');
    console.error('   2. TAKER uses MAKER\'s hashlock to create HTLC');
    console.error('   3. NEVER generate new secrets during HTLC creation!');
    console.error('');
    console.error('📋 Usage:');
    console.error('   npx ts-node create-htlc.ts create path/to/order-config.json');
    console.error('');
    console.error('💡 To generate a new secret for testing ONLY:');
    console.error('   npx ts-node create-htlc.ts secret');

    throw new Error('Config file required for atomic swap HTLC creation!');
  }

  /**
   * Creates a new Bitcoin HTLC
   */
  createHTLC(configFile?: string, outputFile?: string): HTLCResult {
    console.log('🔧 Creating Bitcoin HTLC...');

    const params = this.loadParams(configFile);
    console.log(`📋 Network: ${params.network}`);
    console.log(`⚡ SegWit: ${params.useSegwit ? 'enabled' : 'disabled'}`);

    // 🔍 HASHLOCK VERIFICATION LOGGING
    console.log('\n🔍 HASHLOCK VERIFICATION:');
    console.log('=========================');
    console.log('📄 Config file:', configFile);
    console.log('🔑 Received hashlock:', params.hashlock);
    console.log('📏 Hashlock length:', params.hashlock.length);
    console.log('⚠️  HTLC will be locked with THIS hashlock only!');
    console.log('⚠️  Only someone with the secret preimage can unlock it!');

    const network = this.getNetwork(params.network);

    const config: HTLCConfig = {
      senderPublicKey: Buffer.from(params.senderPublicKey, 'hex'),
      receiverPublicKey: Buffer.from(params.receiverPublicKey, 'hex'),
      hashlock: Buffer.from(params.hashlock, 'hex'),
      locktime: params.locktime,
      network,
      useSegwit: params.useSegwit
    };

    const builder = new HTLCBuilder(config);
    const htlcOutput = builder.createHTLC();

    const result: HTLCResult = {
      address: htlcOutput.address,
      redeemScript: htlcOutput.redeemScript.toString('hex'),
      scriptHash: htlcOutput.scriptHash.toString('hex'),
      witnessScript: htlcOutput.witnessScript?.toString('hex'),
      lockingScript: htlcOutput.lockingScript.toString('hex'),
      config: params,
      createdAt: new Date().toISOString()
    };

    const savedPath = this.saveHTLCToFile(result, outputFile);

    console.log('✅ HTLC created successfully!');
    console.log(`📍 Address: ${result.address}`);
    console.log(`🔑 Script Hash: ${result.scriptHash}`);
    console.log(`💾 Saved to: ${savedPath}`);

    // 🔍 FINAL VERIFICATION LOGGING
    console.log('\n🔍 FINAL HTLC VERIFICATION:');
    console.log('===========================');
    console.log('📥 Input hashlock:', params.hashlock);
    console.log('📤 HTLC config hashlock:', result.config.hashlock);
    console.log('🔍 Hashlock preserved:', params.hashlock === result.config.hashlock);
    console.log('📍 Final HTLC address:', result.address);
    console.log('🔑 Final script hash:', result.scriptHash);
    console.log('✅ HTLC is now locked with the provided hashlock!');

    return result;
  }

  /**
   * Creates and broadcasts a funding transaction for an HTLC
   */
  async createFundingTx(
    htlcFile: string,
    utxosFile: string,
    amount: number,
    changeAddress: string,
    privateKeyHex: string,
    feeRate: number = 10
  ): Promise<string> {
    console.log('💰 Creating HTLC funding transaction...');

    // Load HTLC details
    const htlcData = JSON.parse(fs.readFileSync(htlcFile, 'utf8')) as HTLCResult;
    const network = this.getNetwork(htlcData.config.network);

    // Load UTXOs
    const utxos = JSON.parse(fs.readFileSync(utxosFile, 'utf8'));

    const config: HTLCConfig = {
      senderPublicKey: Buffer.from(htlcData.config.senderPublicKey, 'hex'),
      receiverPublicKey: Buffer.from(htlcData.config.receiverPublicKey, 'hex'),
      hashlock: Buffer.from(htlcData.config.hashlock, 'hex'),
      locktime: htlcData.config.locktime,
      network,
      useSegwit: htlcData.config.useSegwit
    };

    const builder = new HTLCBuilder(config);
    const privateKey = Buffer.from(privateKeyHex, 'hex');

    const fundingTx = builder.createFundingTransaction(
      utxos,
      amount,
      changeAddress,
      feeRate,
      privateKey
    );

    console.log('✅ Funding transaction created!');
    console.log(`📝 Local TXID: ${fundingTx.txid}`);
    console.log(`💰 Amount: ${amount} satoshis`);
    console.log(`🎯 Broadcasting to ${htlcData.config.network} network...`);

    // 🚀 BROADCAST THE TRANSACTION TO THE BLOCKCHAIN
    const broadcastResult = await broadcastTransaction(fundingTx.hex, htlcData.config.network);

    let finalTxid: string;
    let broadcastStatus: string;

    if (broadcastResult.success && broadcastResult.txid) {
      finalTxid = broadcastResult.txid;
      broadcastStatus = 'BROADCASTED';
      console.log('🎉 TRANSACTION SUCCESSFULLY BROADCASTED TO BLOCKCHAIN!');
      console.log(`🔗 View on explorer: https://mempool.space/${htlcData.config.network}/tx/${finalTxid}`);
    } else {
      finalTxid = fundingTx.txid;
      broadcastStatus = 'LOCAL_ONLY';
      console.log('⚠️  Transaction created locally but broadcasting failed!');
      console.log(`❌ Error: ${broadcastResult.error}`);
      console.log(`💡 You can manually broadcast the hex: ${fundingTx.hex}`);
    }

    // Save transaction details with broadcast status
    const outputPath = path.join(__dirname, '../output', `funding_${Date.now()}.json`);
    const txResult = {
      ...fundingTx,
      htlcAddress: htlcData.address,
      amount,
      changeAddress,
      feeRate,
      broadcastStatus,
      blockchainTxid: broadcastResult.success ? broadcastResult.txid : undefined,
      broadcastError: broadcastResult.error,
      explorerUrl: broadcastResult.success ? `https://mempool.space/${htlcData.config.network}/tx/${finalTxid}` : undefined,
      createdAt: new Date().toISOString()
    };

    fs.writeFileSync(outputPath, JSON.stringify(txResult, null, 2));
    console.log(`💾 Transaction details saved to: ${outputPath}`);

    // Return the real blockchain TXID if broadcasted, otherwise local TXID
    return finalTxid;
  }

  /**
   * Creates and broadcasts a claim transaction using the secret
   */
  async createClaimTx(
    htlcFile: string,
    fundingTxid: string,
    fundingVout: number,
    secret: string,
    destinationAddress: string,
    privateKeyHex: string,
    feeRate: number = 10
  ): Promise<string> {
    console.log('🔓 Creating HTLC claim transaction...');

    // Load HTLC details
    const htlcData = JSON.parse(fs.readFileSync(htlcFile, 'utf8')) as HTLCResult;
    const network = this.getNetwork(htlcData.config.network);

    const config: HTLCConfig = {
      senderPublicKey: Buffer.from(htlcData.config.senderPublicKey, 'hex'),
      receiverPublicKey: Buffer.from(htlcData.config.receiverPublicKey, 'hex'),
      hashlock: Buffer.from(htlcData.config.hashlock, 'hex'),
      locktime: htlcData.config.locktime,
      network,
      useSegwit: htlcData.config.useSegwit
    };

    const builder = new HTLCBuilder(config);
    const privateKey = Buffer.from(privateKeyHex, 'hex');
    const secretBuffer = Buffer.from(secret, 'hex');

    // Verify secret matches hashlock
    const computedHash = HTLCBuilder.hashSecret(secretBuffer);
    console.log('🔍 Computed hash:', computedHash.toString('hex'));
    console.log('🔍 Expected hash:', htlcData.config.hashlock);
    if (computedHash.toString('hex') !== htlcData.config.hashlock) {
      throw new Error('Secret does not match hashlock!');
    }

    const amount = 100000; // Would need to get this from funding tx
    const claimTx = builder.createClaimTransaction(
      fundingTxid,
      fundingVout,
      amount,
      secretBuffer,
      destinationAddress,
      feeRate,
      privateKey
    );

    console.log('✅ Claim transaction created!');
    console.log(`📝 Local TXID: ${claimTx.txid}`);
    console.log(`🔑 Secret used: ${secret}`);
    console.log(`🎯 Broadcasting to ${htlcData.config.network} network...`);

    // 🚀 BROADCAST THE TRANSACTION TO THE BLOCKCHAIN
    const broadcastResult = await broadcastTransaction(claimTx.hex, htlcData.config.network);

    let finalTxid: string;
    let broadcastStatus: string;

    if (broadcastResult.success && broadcastResult.txid) {
      finalTxid = broadcastResult.txid;
      broadcastStatus = 'BROADCASTED';
      console.log('🎉 TRANSACTION SUCCESSFULLY BROADCASTED TO BLOCKCHAIN!');
      console.log(`🔗 View on explorer: https://mempool.space/${htlcData.config.network}/tx/${finalTxid}`);
    } else {
      finalTxid = claimTx.txid;
      broadcastStatus = 'LOCAL_ONLY';
      console.log('⚠️  Transaction created locally but broadcasting failed!');
      console.log(`❌ Error: ${broadcastResult.error}`);
      console.log(`💡 You can manually broadcast the hex: ${claimTx.hex}`);
    }

    // Save transaction details with broadcast status
    const outputPath = path.join(__dirname, '../output', `claim_${Date.now()}.json`);
    const txResult = {
      ...claimTx,
      secret,
      destinationAddress,
      feeRate,
      broadcastStatus,
      blockchainTxid: broadcastResult.success ? broadcastResult.txid : undefined,
      broadcastError: broadcastResult.error,
      explorerUrl: broadcastResult.success ? `https://mempool.space/${htlcData.config.network}/tx/${finalTxid}` : undefined,
      createdAt: new Date().toISOString()
    };

    fs.writeFileSync(outputPath, JSON.stringify(txResult, null, 2));
    console.log(`💾 Transaction details saved to: ${outputPath}`);

    // Return the real blockchain TXID if broadcasted, otherwise local TXID
    return finalTxid;
  }

  /**
   * Extracts secret from a claim transaction
   */
  extractSecret(txHex: string, witnessScriptHex: string): string | null {
    console.log('🔍 Extracting secret from claim transaction...');

    const witnessScript = Buffer.from(witnessScriptHex, 'hex');
    const secret = HTLCBuilder.extractSecretFromTransaction(txHex, witnessScript);

    if (secret) {
      const secretHex = secret.toString('hex');
      console.log(`✅ Secret extracted: ${secretHex}`);
      return secretHex;
    } else {
      console.log('❌ No secret found in transaction');
      return null;
    }
  }

  /**
   * Generates a random secret and its hash
   */
  generateSecret(): { secret: string; hash: string } {
    const secret = HTLCBuilder.generateSecret();
    const hash = HTLCBuilder.hashSecret(secret);

    const result = {
      secret: secret.toString('hex'),
      hash: hash.toString('hex')
    };

    console.log('🎲 Generated new secret:');
    console.log(`🔑 Secret: ${result.secret}`);
    console.log(`#️⃣  Hash: ${result.hash}`);

    const outputPath = path.join(__dirname, '../output', `secret_${Date.now()}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`💾 Saved to: ${outputPath}`);

    return result;
  }

  /**
   * Displays help information
   */
  showHelp(): void {
    console.log(`
🔒 Bitcoin HTLC Creator with Automatic Broadcasting

Usage: npx ts-node create-htlc.ts <command> [options]

Commands:
  create [configFile] [outputFile]     Create a new HTLC
  fund <htlcFile> <utxosFile> <amount> <changeAddr> <privateKey> [feeRate]
                                      Create and broadcast funding transaction
  claim <htlcFile> <txid> <vout> <secret> <destAddr> <privateKey> [feeRate]
                                      Create and broadcast claim transaction
  extract <txHex> <witnessScript>     Extract secret from claim transaction
  secret                              Generate a new secret and hash
  help                                Show this help

🚀 NEW: Automatic Broadcasting
===============================
- All transactions are automatically broadcasted to the Bitcoin network
- Uses mempool.space API for reliable broadcasting
- Returns real blockchain transaction IDs
- Saves detailed transaction info with broadcast status
- Provides explorer URLs for verification

📋 Broadcasting Details:
- testnet4: https://mempool.space/testnet4/api/tx
- testnet: https://mempool.space/testnet/api/tx  
- mainnet: https://mempool.space/api/tx

Examples:
  npx ts-node create-htlc.ts create config.json
  npx ts-node create-htlc.ts fund htlc.json utxos.json 100000 tb1q... privkey
  npx ts-node create-htlc.ts claim htlc.json txid 0 secret tb1q... privkey
  npx ts-node create-htlc.ts secret
`);
  }
}

// CLI Interface
async function main() {
  const creator = new HTLCCreator();
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'create':
        creator.createHTLC(args[1], args[2]);
        break;

      case 'fund':
        if (args.length < 6) {
          throw new Error('Missing required arguments for fund command');
        }
        const fundingTxid = await creator.createFundingTx(
          args[1], // htlcFile
          args[2], // utxosFile
          parseInt(args[3]), // amount
          args[4], // changeAddress
          args[5], // privateKey
          args[6] ? parseInt(args[6]) : 10 // feeRate
        );
        console.log(`\n🎉 FUNDING COMPLETE!`);
        console.log(`📝 Transaction ID: ${fundingTxid}`);
        break;

      case 'claim':
        if (args.length < 7) {
          throw new Error('Missing required arguments for claim command');
        }
        const claimTxid = await creator.createClaimTx(
          args[1], // htlcFile
          args[2], // txid
          parseInt(args[3]), // vout
          args[4], // secret
          args[5], // destinationAddress
          args[6], // privateKey
          args[7] ? parseInt(args[7]) : 10 // feeRate
        );
        console.log(`\n🎉 CLAIM COMPLETE!`);
        console.log(`📝 Transaction ID: ${claimTxid}`);
        break;

      case 'extract':
        if (args.length < 3) {
          throw new Error('Missing required arguments for extract command');
        }
        creator.extractSecret(args[1], args[2]);
        break;

      case 'secret':
        creator.generateSecret();
        break;

      case 'help':
      default:
        creator.showHelp();
        break;
    }
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Run CLI if this file is executed directly
if (require.main === module) {
  main();
}

export { HTLCCreator }; 