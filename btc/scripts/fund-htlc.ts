import { HTLCBuilder } from '../lib/htlc-builder';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// Check if fetch is available, otherwise use curl as fallback
const hasFetch = typeof fetch !== 'undefined';

// Initialize ECPair factory
const ECPair = ECPairFactory(ecc);

interface BitcoinUTXO {
  txid: string;
  vout: number;
  value: number;
  scriptPubKey: string;
  address: string;
}

async function getUTXOsWithCurl(address: string, network: string): Promise<BitcoinUTXO[]> {
  return new Promise((resolve, reject) => {
    const apiUrl = network === 'testnet4'
      ? `https://mempool.space/testnet4/api/address/${address}/utxo`
      : `https://blockstream.info/api/address/${address}/utxo`;

    console.log("🔍 Fetching UTXOs with curl from:", apiUrl);

    const curlProcess = spawn('curl', [
      '-s',
      '-H', 'User-Agent: Bitcoin-HTLC-Funding/1.0',
      apiUrl
    ]);

    let response = '';
    let errorOutput = '';

    curlProcess.stdout.on('data', (data: Buffer) => {
      response += data.toString();
    });

    curlProcess.stderr.on('data', (data: Buffer) => {
      errorOutput += data.toString();
    });

    curlProcess.on('close', (code) => {
      if (code === 0 && response.trim()) {
        try {
          const data = JSON.parse(response);
          if (!Array.isArray(data) || data.length === 0) {
            reject(new Error("No UTXOs found for address"));
            return;
          }

          const utxos: BitcoinUTXO[] = data.map((utxo: any) => ({
            txid: utxo.txid,
            vout: utxo.vout,
            value: utxo.value,
            scriptPubKey: '', // Will fetch from full transaction
            address: address
          }));

          console.log(`✅ Found ${utxos.length} UTXOs`);
          console.log(`💰 Total value: ${utxos.reduce((sum, u) => sum + u.value, 0).toLocaleString()} satoshis`);
          resolve(utxos);
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e}`));
        }
      } else {
        reject(new Error(`Curl failed with code ${code}: ${errorOutput}`));
      }
    });
  });
}

async function getUTXOs(address: string, network: string): Promise<BitcoinUTXO[]> {
  try {
    // For testnet4, use mempool.space API
    const apiUrl = network === 'testnet4'
      ? `https://mempool.space/testnet4/api/address/${address}/utxo`
      : `https://blockstream.info/api/address/${address}/utxo`;

    console.log("🔍 Fetching UTXOs from:", apiUrl);

    // Add timeout and better error handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const response = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Bitcoin-HTLC-Funding/1.0'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("No UTXOs found for address");
    }

    const utxos: BitcoinUTXO[] = data.map((utxo: any) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      value: utxo.value,
      scriptPubKey: '', // Will fetch from full transaction
      address: address
    }));

    console.log(`✅ Found ${utxos.length} UTXOs`);
    console.log(`💰 Total value: ${utxos.reduce((sum, u) => sum + u.value, 0).toLocaleString()} satoshis`);
    return utxos;

  } catch (error: any) {
    console.error("❌ Failed to fetch UTXOs with fetch:", error.message);
    console.log("🔄 Trying with curl fallback...");

    try {
      return await getUTXOsWithCurl(address, network);
    } catch (curlError: any) {
      console.error("❌ Failed to fetch UTXOs with curl:", curlError.message);
      return [];
    }
  }
}

async function getTransactionWithCurl(txid: string, network: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const apiUrl = network === 'testnet4'
      ? `https://mempool.space/testnet4/api/tx/${txid}/hex`
      : `https://blockstream.info/api/tx/${txid}/hex`;

    console.log(`🔍 Fetching transaction ${txid} raw hex with curl from ${apiUrl}`);

    const curlProcess = spawn('curl', [
      '-s',
      '-H', 'User-Agent: Bitcoin-HTLC-Funding/1.0',
      apiUrl
    ]);

    let response = '';
    let errorOutput = '';

    curlProcess.stdout.on('data', (data: Buffer) => {
      response += data.toString();
    });

    curlProcess.stderr.on('data', (data: Buffer) => {
      errorOutput += data.toString();
    });

    curlProcess.on('close', (code) => {
      if (code === 0 && response.trim()) {
        const hexData = response.trim();
        if (!hexData || hexData.length === 0) {
          reject(new Error(`Invalid transaction data: empty hex response`));
          return;
        }

        const data = {
          hex: hexData,
          txid: txid
        };

        console.log(`✅ Successfully fetched transaction ${txid} with curl (${hexData.length} chars)`);
        resolve(data);
      } else {
        reject(new Error(`Curl failed with code ${code}: ${errorOutput}`));
      }
    });
  });
}

async function getTransaction(txid: string, network: string): Promise<any> {
  try {
    // For mempool.space, we need to get the raw hex separately
    const apiUrl = network === 'testnet4'
      ? `https://mempool.space/testnet4/api/tx/${txid}/hex`
      : `https://blockstream.info/api/tx/${txid}/hex`;

    console.log(`🔍 Fetching transaction ${txid} raw hex from ${apiUrl}`);

    // Add timeout and better error handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const response = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Bitcoin-HTLC-Funding/1.0'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const hexData = await response.text();

    if (!hexData || hexData.length === 0) {
      throw new Error(`Invalid transaction data: empty hex response`);
    }

    // Create a mock data object with the hex field
    const data = {
      hex: hexData.trim(),
      txid: txid
    };

    console.log(`✅ Successfully fetched transaction ${txid} (${hexData.length} chars)`);
    return data;

  } catch (error: any) {
    console.error("❌ Failed to fetch transaction with fetch:", error.message);
    console.log("🔄 Trying with curl fallback...");

    try {
      return await getTransactionWithCurl(txid, network);
    } catch (curlError: any) {
      console.error("❌ Failed to fetch transaction with curl:", curlError.message);
      throw curlError;
    }
  }
}

async function broadcastTransaction(txHex: string, network: string): Promise<string> {
  try {
    // For testnet4, use mempool.space API
    const apiUrl = network === 'testnet4'
      ? 'https://mempool.space/testnet4/api/tx'
      : 'https://blockstream.info/api/tx';

    console.log("📡 Broadcasting transaction to:", apiUrl);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: txHex
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Broadcast failed: ${error}`);
    }

    const txid = await response.text();
    console.log("✅ Transaction broadcasted successfully!");
    return txid;

  } catch (error: any) {
    console.error("❌ Failed to broadcast transaction:", error.message);
    throw error;
  }
}

async function main() {
  console.log("🚀 FUNDING BITCOIN HTLC");
  console.log("========================");

  // Parse command line arguments
  const args = process.argv.slice(2);
  const htlcAddress = args.find(arg => arg.startsWith('--address='))?.split('=')[1];
  const amount = parseInt(args.find(arg => arg.startsWith('--amount='))?.split('=')[1] || '0');
  const network = args.find(arg => arg.startsWith('--network='))?.split('=')[1] || 'testnet4';

  if (!htlcAddress || !amount) {
    console.log("❌ Usage: ts-node fund-htlc.ts --address=<htlc_address> --amount=<satoshis> --network=<network>");
    process.exit(1);
  }

  console.log("📋 Funding Parameters:");
  console.log("🔸 HTLC Address:", htlcAddress);
  console.log("🔸 Amount:", amount, "satoshis");
  console.log("�� Network:", network);

  // Get environment variables
  const privateKeyHex = process.env.BITCOIN_PRIVATE_KEY;
  const fromAddress = process.env.BITCOIN_ADDRESS;

  if (!privateKeyHex || !fromAddress) {
    throw new Error("❌ Please set BITCOIN_PRIVATE_KEY and BITCOIN_ADDRESS environment variables");
  }

  console.log("🔸 From Address:", fromAddress);

  // Get Bitcoin network
  const bitcoinNetwork = network === 'testnet4' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;

  try {
    // Get UTXOs for the funding address
    console.log("\n🔍 Fetching UTXOs...");
    const utxos = await getUTXOs(fromAddress, network);

    if (utxos.length === 0) {
      throw new Error("❌ No UTXOs found. Please fund your address from a faucet first.");
    }

    // Calculate total available
    const totalAvailable = utxos.reduce((sum, utxo) => sum + utxo.value, 0);
    console.log("💰 Total available:", totalAvailable, "satoshis");

    const fee = 1000; // 1000 sats fee
    if (totalAvailable < amount + fee) {
      throw new Error(`❌ Insufficient funds. Available: ${totalAvailable}, Required: ${amount + fee} (including fees)`);
    }

    // Create funding transaction
    console.log("\n🔨 Creating funding transaction...");

    // Handle both WIF and hex private key formats
    let keyPair;
    if (privateKeyHex.length === 64) {
      // Hex format (32 bytes)
      keyPair = ECPair.fromPrivateKey(Buffer.from(privateKeyHex, 'hex'));
    } else {
      // WIF format
      keyPair = ECPair.fromWIF(privateKeyHex, bitcoinNetwork);
    }
    const psbt = new bitcoin.Psbt({ network: bitcoinNetwork });

    // Add inputs
    let inputValue = 0;
    for (const utxo of utxos) {
      if (inputValue >= amount + fee) break;

      // Determine address type based on prefix
      const isLegacy = fromAddress.startsWith('m') || fromAddress.startsWith('n') || fromAddress.startsWith('1') || fromAddress.startsWith('2');
      const isSegWit = fromAddress.startsWith('tb1') || fromAddress.startsWith('bc1') || fromAddress.startsWith('bcrt1');

      console.log(`🔸 Address type: ${isLegacy ? 'Legacy' : isSegWit ? 'SegWit' : 'Unknown'}`);

      if (isSegWit) {
        // Native SegWit (P2WPKH)
        const p2wpkhScript = bitcoin.payments.p2wpkh({
          address: fromAddress,
          network: bitcoinNetwork
        }).output;

        if (p2wpkhScript) {
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
              script: p2wpkhScript,
              value: utxo.value,
            },
          });
          inputValue += utxo.value;
          console.log(`✅ Added SegWit input: ${utxo.txid}:${utxo.vout} (${utxo.value} sats)`);
        }
      } else if (isLegacy) {
        // Legacy (P2PKH) - need full transaction data
        try {
          const txData = await getTransaction(utxo.txid, network);

          if (!txData || !txData.hex) {
            throw new Error(`Invalid transaction data for ${utxo.txid}: missing hex field`);
          }

          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            nonWitnessUtxo: Buffer.from(txData.hex, 'hex'),
          });
          inputValue += utxo.value;
          console.log(`✅ Added Legacy input: ${utxo.txid}:${utxo.vout} (${utxo.value} sats)`);
        } catch (e) {
          console.error(`❌ Failed to fetch transaction data for ${utxo.txid}`);
          console.error(`❌ Error details:`, e instanceof Error ? e.message : String(e));
          throw e;
        }
      } else {
        throw new Error(`Unsupported address format: ${fromAddress}`);
      }
    }

    // Add output to HTLC
    psbt.addOutput({
      address: htlcAddress,
      value: amount,
    });

    // Add change output if needed
    const change = inputValue - amount - fee;
    if (change > 546) { // Dust threshold
      psbt.addOutput({
        address: fromAddress,
        value: change,
      });
      console.log(`✅ Added change output: ${change} sats`);
    }

    // Sign all inputs
    for (let i = 0; i < psbt.inputCount; i++) {
      psbt.signInput(i, keyPair);
    }

    // Finalize and extract transaction
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    const txid = psbt.extractTransaction().getId();

    console.log("✅ Transaction created successfully!");
    console.log("🔸 TXID:", txid);
    console.log("🔸 Size:", txHex.length / 2, "bytes");
    console.log("🔸 Fee:", fee, "satoshis");

    // Broadcast transaction
    console.log("\n📡 Broadcasting transaction...");
    const broadcastTxId = await broadcastTransaction(txHex, network);

    console.log("\n✅ HTLC FUNDED SUCCESSFULLY!");
    console.log("============================");
    console.log("📝 Transaction ID:", broadcastTxId);
    console.log("💰 Amount:", amount, "satoshis");
    console.log("📍 HTLC Address:", htlcAddress);
    console.log("🔍 Explorer URL:", `https://mempool.space/${network}/tx/${broadcastTxId}`);

    // Save transaction details
    const outputDir = path.join(__dirname, '..', 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const fundingData = {
      txid: broadcastTxId,
      htlcAddress,
      amount,
      network,
      timestamp: Date.now(),
      explorerUrl: `https://mempool.space/${network}/tx/${broadcastTxId}`,
      hex: txHex
    };

    const filename = `funding_${Date.now()}.json`;
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(fundingData, null, 2));

    console.log("📄 Transaction saved to:", filepath);

  } catch (error: any) {
    console.error("❌ ERROR:", error.message);
    process.exit(1);
  }
}

main().catch(console.error); 