#!/usr/bin/env node

/**
 * @title Bitcoin HTLC Claim Script (Reverse Flow)
 * @notice Claims BTC from HTLC using revealed secret from Monad transaction
 * @dev Handles signature verification correctly for reverse atomic swaps
 */

import * as bitcoin from 'bitcoinjs-lib';
import ECPair from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import * as crypto from 'crypto';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

// Initialize ECPair factory
const ECPairFactory = ECPair(ecc);

// Bitcoin network configuration
const NETWORKS = {
  testnet4: {
    messagePrefix: '\x18Bitcoin Signed Message:\n',
    bech32: 'tb',
    bip32: {
      public: 0x043587cf,
      private: 0x04358394,
    },
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    wif: 0xef,
  },
  testnet: bitcoin.networks.testnet,
  mainnet: bitcoin.networks.bitcoin,
};

interface HTLCConfig {
  address: string;
  scriptHash: string;
  amount: string;
  network: string;
  locktime: number;
  senderPublicKey: string;
  receiverPublicKey: string;
  hashlock: string;
  witnessScript?: string; // Added for pre-calculated HTLC script
}

interface UTXO {
  txid: string;
  vout: number;
  value: number;
  scriptPubKey?: string;
}

async function getUTXOs(address: string, network: string): Promise<UTXO[]> {
  const baseUrl = network === 'testnet4'
    ? 'https://mempool.space/testnet4/api'
    : network === 'testnet'
      ? 'https://mempool.space/testnet/api'
      : 'https://mempool.space/api';

  try {
    const response = await axios.get(`${baseUrl}/address/${address}/utxo`);
    return response.data.map((utxo: any) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      value: utxo.value,
      scriptPubKey: utxo.scriptPubKey
    }));
  } catch (error) {
    console.error('❌ Error fetching UTXOs:', error);
    return [];
  }
}

async function broadcastTransaction(txHex: string, network: string): Promise<string> {
  const baseUrl = network === 'testnet4'
    ? 'https://mempool.space/testnet4/api'
    : network === 'testnet'
      ? 'https://mempool.space/testnet/api'
      : 'https://mempool.space/api';

  try {
    const response = await axios.post(`${baseUrl}/tx`, txHex, {
      headers: {
        'Content-Type': 'text/plain'
      }
    });
    return response.data;
  } catch (error: any) {
    console.error('❌ Broadcasting failed:', error.response?.data || error.message);
    throw new Error(`Broadcasting failed: ${error.response?.data || error.message}`);
  }
}

function createHTLCScript(senderPubKey: string, receiverPubKey: string, hashlock: string, locktime: number): Buffer {
  const senderPubKeyBuffer = Buffer.from(senderPubKey, 'hex');
  const receiverPubKeyBuffer = Buffer.from(receiverPubKey, 'hex');
  const hashlockBuffer = Buffer.from(hashlock, 'hex');
  const locktimeBuffer = Buffer.alloc(4);
  locktimeBuffer.writeUInt32LE(locktime, 0);

  // HTLC Script: OP_IF OP_SHA256 <hashlock> OP_EQUALVERIFY <receiverPubKey> OP_ELSE <locktime> OP_CLTV OP_DROP <senderPubKey> OP_ENDIF OP_CHECKSIG
  const script = bitcoin.script.compile([
    bitcoin.opcodes.OP_IF,
    bitcoin.opcodes.OP_SHA256,
    hashlockBuffer,
    bitcoin.opcodes.OP_EQUALVERIFY,
    receiverPubKeyBuffer,
    bitcoin.opcodes.OP_ELSE,
    locktimeBuffer,
    bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
    bitcoin.opcodes.OP_DROP,
    senderPubKeyBuffer,
    bitcoin.opcodes.OP_ENDIF,
    bitcoin.opcodes.OP_CHECKSIG
  ]);

  return script;
}

async function claimHTLC(
  htlcConfig: HTLCConfig,
  fundingTxId: string,
  fundingVout: number,
  secret: string,
  destinationAddress: string,
  privateKey: string,
  feeRate: number = 10
): Promise<string> {

  console.log('🔓 CLAIMING BITCOIN FROM HTLC...');
  console.log('================================');

  const network = NETWORKS[htlcConfig.network as keyof typeof NETWORKS];
  if (!network) {
    throw new Error(`❌ Unsupported network: ${htlcConfig.network}`);
  }

  // Verify secret matches hashlock
  const secretBuffer = Buffer.from(secret, 'hex');
  const calculatedHashlock = crypto.createHash('sha256').update(secretBuffer).digest('hex');

  console.log('🔍 Secret verification:');
  console.log('🔑 Secret:', secret);
  console.log('🔒 Expected hashlock:', htlcConfig.hashlock);
  console.log('🧮 Calculated hashlock:', calculatedHashlock);

  if (calculatedHashlock !== htlcConfig.hashlock) {
    throw new Error('❌ Secret does not match hashlock!');
  }
  console.log('✅ Secret verification successful!');

  // Use the witnessScript from the HTLC config file instead of recreating it
  const htlcScript = htlcConfig.witnessScript
    ? Buffer.from(htlcConfig.witnessScript, 'hex')
    : createHTLCScript(
      htlcConfig.senderPublicKey,
      htlcConfig.receiverPublicKey,
      htlcConfig.hashlock,
      htlcConfig.locktime
    );

  // Get funding UTXO details
  console.log('🔍 Fetching funding transaction details...');
  const baseUrl = htlcConfig.network === 'testnet4'
    ? 'https://mempool.space/testnet4/api'
    : 'https://mempool.space/testnet/api';

  const fundingTxResponse = await axios.get(`${baseUrl}/tx/${fundingTxId}`);
  const fundingTx = fundingTxResponse.data;
  const fundingOutput = fundingTx.vout[fundingVout];

  if (!fundingOutput) {
    throw new Error(`❌ Funding output ${fundingVout} not found in transaction ${fundingTxId}`);
  }

  const fundingAmount = fundingOutput.value;
  console.log('💰 Funding amount:', fundingAmount, 'satoshis');

  // Calculate fee
  const estimatedSize = 300; // Conservative estimate for witness transaction
  const fee = Math.ceil(estimatedSize * feeRate);
  const outputAmount = fundingAmount - fee;

  if (outputAmount <= 0) {
    throw new Error('❌ Insufficient funds to cover fee');
  }

  // Create transaction manually for better control
  const tx = new bitcoin.Transaction();
  tx.version = 2;

  // Add input
  tx.addInput(Buffer.from(fundingTxId, 'hex').reverse(), fundingVout);

  // Add output
  const outputScript = bitcoin.address.toOutputScript(destinationAddress, network);
  tx.addOutput(outputScript, outputAmount);

  // Sign the transaction
  const keyPair = ECPairFactory.fromPrivateKey(Buffer.from(privateKey, 'hex'), { network });

  // Create signature hash for witness v0
  const hashType = bitcoin.Transaction.SIGHASH_ALL;
  const signatureHash = tx.hashForWitnessV0(0, htlcScript, fundingAmount, hashType);

  // Create DER-encoded signature
  const signature = keyPair.sign(signatureHash);

  // Convert to DER format and ensure canonical signature
  const derSignature = bitcoin.script.signature.encode(signature, hashType);

  // Verify the signature is canonical (low S value)
  if (!bitcoin.script.signature.decode(derSignature)) {
    throw new Error('❌ Failed to create canonical DER signature');
  }

  // Build witness stack for secret path: [signature] [secret] [1] [witnessScript]
  const witness = [
    derSignature,
    secretBuffer,
    Buffer.from([1]), // Choose secret path (OP_IF branch)
    htlcScript
  ];

  // Set witness for input
  tx.ins[0].witness = witness;

  const txHex = tx.toHex();

  console.log('✅ Claim transaction created:');
  console.log('📋 Transaction ID:', tx.getId());
  console.log('📋 Transaction size:', txHex.length / 2, 'bytes');
  console.log('💰 Output amount:', outputAmount, 'satoshis');
  console.log('💰 Fee:', fee, 'satoshis');

  // Broadcast transaction
  console.log('📡 Broadcasting transaction...');
  try {
    const broadcastedTxId = await broadcastTransaction(txHex, htlcConfig.network);
    console.log('✅ Transaction broadcasted successfully!');
    console.log('📝 Broadcasted TXID:', broadcastedTxId);

    // Save transaction details
    const claimResult = {
      txid: tx.getId(),
      broadcastedTxid: broadcastedTxId,
      hex: txHex,
      secret: secret,
      hashlock: htlcConfig.hashlock,
      amount: outputAmount,
      fee: fee,
      network: htlcConfig.network,
      timestamp: Date.now(),
      broadcasted: true
    };

    const outputFile = path.join(__dirname, '../output', `claim_reverse_${Date.now()}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(claimResult, null, 2));
    console.log('💾 Transaction saved to:', outputFile);

    return broadcastedTxId;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ Broadcasting failed:', errorMessage);

    // Save transaction details even if broadcasting failed
    const claimResult = {
      txid: tx.getId(),
      hex: txHex,
      secret: secret,
      hashlock: htlcConfig.hashlock,
      amount: outputAmount,
      fee: fee,
      network: htlcConfig.network,
      timestamp: Date.now(),
      broadcasted: false,
      error: errorMessage
    };

    const outputFile = path.join(__dirname, '../output', `claim_reverse_failed_${Date.now()}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(claimResult, null, 2));
    console.log('💾 Transaction saved to:', outputFile);

    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 5) {
    console.log('❌ Usage: ts-node claim-htlc-reverse.ts <htlc-address> <funding-txid> <funding-vout> <secret> <destination-address> [fee-rate]');
    console.log('📋 Example: ts-node claim-htlc-reverse.ts tb1q... abcd1234... 0 secret123... tb1q... 10');
    process.exit(1);
  }

  const [htlcAddress, fundingTxId, fundingVoutStr, secret, destinationAddress, feeRateStr] = args;
  const fundingVout = parseInt(fundingVoutStr);
  const feeRate = parseInt(feeRateStr) || 10;

  // Environment variables
  const privateKey = process.env.BITCOIN_PRIVATE_KEY;
  const network = process.env.BITCOIN_NETWORK || 'testnet4';

  if (!privateKey) {
    throw new Error('❌ BITCOIN_PRIVATE_KEY environment variable required');
  }

  // Find HTLC config file
  const outputDir = path.join(__dirname, '../output');
  const htlcFiles = fs.readdirSync(outputDir)
    .filter(f => f.startsWith('htlc_') && f.endsWith('.json'))
    .sort((a, b) => fs.statSync(path.join(outputDir, b)).mtime.getTime() -
      fs.statSync(path.join(outputDir, a)).mtime.getTime());

  if (htlcFiles.length === 0) {
    throw new Error('❌ No HTLC config files found');
  }

  const htlcFile = htlcFiles[0];
  const htlcConfig = JSON.parse(fs.readFileSync(path.join(outputDir, htlcFile), 'utf8'));

  // Reconstruct HTLC config
  const htlcData: HTLCConfig = {
    address: htlcAddress,
    scriptHash: htlcConfig.scriptHash || '',
    amount: htlcConfig.amount || '0.002',
    network: network,
    locktime: htlcConfig.config?.locktime || htlcConfig.locktime,
    senderPublicKey: htlcConfig.config?.senderPublicKey || htlcConfig.senderPublicKey,
    receiverPublicKey: htlcConfig.config?.receiverPublicKey || htlcConfig.receiverPublicKey,
    hashlock: htlcConfig.config?.hashlock || htlcConfig.hashlock,
    witnessScript: htlcConfig.witnessScript
  };

  console.log('🎯 REVERSE FLOW BITCOIN CLAIM');
  console.log('==============================');
  console.log('🔸 HTLC Address:', htlcAddress);
  console.log('🔸 Funding TX:', fundingTxId);
  console.log('🔸 Funding Output:', fundingVout);
  console.log('🔸 Secret:', secret);
  console.log('🔸 Destination:', destinationAddress);
  console.log('🔸 Network:', network);
  console.log('🔸 Fee Rate:', feeRate, 'sat/vB');

  try {
    const txId = await claimHTLC(
      htlcData,
      fundingTxId,
      fundingVout,
      secret,
      destinationAddress,
      privateKey,
      feeRate
    );

    console.log('🎉 BITCOIN CLAIM SUCCESSFUL!');
    console.log('=============================');
    console.log('✅ Transaction ID:', txId);
    console.log('🔗 Explorer URL:', `https://mempool.space/${network}/tx/${txId}`);
    console.log('💰 BTC successfully claimed using revealed secret!');

  } catch (error) {
    console.error('❌ Claim failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export { claimHTLC, main as claimHTLCMain }; 