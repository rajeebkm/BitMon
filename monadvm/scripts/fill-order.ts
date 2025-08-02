import { ethers } from "hardhat";
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

interface AtomicSwapOrder {
  orderId: string;
  timestamp: number;
  network: string;
  chainId: number;

  // Order details
  maker: {
    address: string;
    provides: {
      asset: "ETH" | "ERC20";
      amount: string;
      token?: string;
    };
    wants: {
      asset: "BTC";
      amount: string;
      address: string;
      publicKey: string;
    };
  };

  // Taker info (added when order is filled)
  taker?: {
    address: string;
    bitcoinAddress: string;
  };

  // Cryptographic details
  secret: string;
  hashlock: string;

  // Timelock configuration
  timelock: {
    withdrawalPeriod: number;
    cancellationPeriod: number;
  };

  // Order status
  status: "CREATED" | "FILLED" | "COMPLETED" | "CANCELLED";

  // Deployment info
  contracts: {
    btcEscrowFactory: string;
    accessToken: string;
  };

  // Bitcoin HTLC info (added when order is filled)
  bitcoinHTLC?: {
    address: string;
    scriptHash: string;
    amount: string;
    network: string;
    locktime: number;
  };

  // Transaction tracking
  transactions?: {
    bitcoinHTLCFunding?: string;
    monadvmEscrowCreation?: string;
    bitcoinHTLCClaim?: string;
    monadvmEscrowClaim?: string;
  };
}

async function main() {
  console.log("🎯 FILLING ATOMIC SWAP ORDER");
  console.log("============================");
  console.log("💡 TAKER: Filling maker's order by creating Bitcoin HTLC");

  // Get order ID from environment variable or command line
  const orderId = process.env.ORDER_ID || process.argv[process.argv.length - 1];
  if (!orderId || orderId.includes('.ts')) {
    console.log("❌ Please provide order ID");
    console.log("Usage: ORDER_ID=order_1234567890 npm run fill:order");
    console.log("   or: npm run fill:order order_1234567890");
    process.exit(1);
  }

  // Load order
  const ordersDir = path.join(__dirname, '..', '..', 'orders');
  const orderPath = path.join(ordersDir, `${orderId}.json`);

  if (!fs.existsSync(orderPath)) {
    throw new Error(`❌ Order not found: ${orderPath}`);
  }

  const order: AtomicSwapOrder = JSON.parse(fs.readFileSync(orderPath, 'utf8'));
  console.log("📄 Loaded order:", orderId);
  console.log("⏰ Created:", new Date(order.timestamp).toISOString());

  if (order.status !== "CREATED") {
    throw new Error(`❌ Order status is ${order.status}, expected CREATED`);
  }

  // Get network info
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  if (chainId !== order.chainId) {
    throw new Error(`❌ Network mismatch! Order is for chain ${order.chainId}, you're on ${chainId}`);
  }

  // Get taker account
  const signers = await ethers.getSigners();
  let taker: any;

  if (process.env.TAKER_ADDRESS) {
    const targetAddress = process.env.TAKER_ADDRESS;
    taker = signers.find(s => s.address.toLowerCase() === targetAddress.toLowerCase());
    if (!taker) {
      throw new Error(`❌ TAKER_ADDRESS ${targetAddress} not found in available signers`);
    }
  } else {
    taker = signers[1] || signers[0]; // Default to second signer, fallback to first
  }

  if (!taker) {
    throw new Error("❌ No signers available. Please check your network configuration.");
  }

  console.log("👤 TAKER:", taker.address);
  const takerBalance = await ethers.provider.getBalance(taker.address);
  console.log("💰 TAKER Balance:", ethers.formatEther(takerBalance), "ETH");

  // Validate Bitcoin configuration
  const bitcoinPrivateKey = process.env.BITCOIN_PRIVATE_KEY;
  const bitcoinAddress = process.env.BITCOIN_ADDRESS;
  const bitcoinNetwork = process.env.BITCOIN_NETWORK || "testnet4";

  if (!bitcoinPrivateKey || !bitcoinAddress) {
    throw new Error("❌ Please set BITCOIN_PRIVATE_KEY and BITCOIN_ADDRESS in .env file");
  }

  console.log("\n📋 ORDER DETAILS:");
  console.log("=================");
  console.log("🔸 MAKER:", order.maker.address);
  console.log("🔸 MAKER provides:", ethers.formatEther(order.maker.provides.amount), "ETH");
  console.log("🔸 MAKER wants:", order.maker.wants.amount, "BTC");
  console.log("🔸 Bitcoin address:", order.maker.wants.address);
  console.log("🔸 TAKER:", taker.address);
  console.log("🔸 Bitcoin network:", bitcoinNetwork);

  // Create Bitcoin HTLC
  console.log("\n🔗 Step 1: Creating Bitcoin HTLC...");
  console.log("====================================");

  const btcAmount = parseFloat(order.maker.wants.amount);
  const btcSatoshis = Math.floor(btcAmount * 100000000); // Convert to satoshis

  console.log("💰 HTLC Amount:", btcAmount, "BTC", `(${btcSatoshis} satoshis)`);
  console.log("🔒 Using hashlock:", order.hashlock);
  console.log("📍 Recipient:", order.maker.wants.address);

  // 🔍 SECRET/HASHLOCK COORDINATION LOGGING
  console.log("\n🔍 SECRET/HASHLOCK VERIFICATION:");
  console.log("================================");
  console.log("📄 Order secret:", order.secret);
  console.log("📄 Order hashlock:", order.hashlock);
  console.log("🔄 Hashlock without 0x:", order.hashlock.slice(2));
  console.log("⚠️  HTLC creation should ONLY use hashlock, NEVER the secret!");

  try {
    // 🔧 GET ACTUAL PUBLIC KEYS FROM ORDER AND ENVIRONMENT
    console.log("\n🔧 USING REAL PUBLIC KEYS:");
    console.log("==========================");

    // Import Bitcoin libraries for key derivation
    const bitcoin = require('bitcoinjs-lib');
    
    console.log("here1");
    const { ECPairFactory } = require('ecpair');
    console.log("here2");

    const ecc = require('tiny-secp256k1');
    console.log("here3");
    
    const ECPair = ECPairFactory(ecc);

    // Get Bitcoin network
    const btcNetwork = bitcoinNetwork === 'testnet4' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
    console.log("bitcoinPrivateKey", bitcoinPrivateKey);
    console.log("bitcoinNetwork", bitcoinNetwork);
    console.log("btcNetwork", btcNetwork);
    console.log("bitcoinPrivateKey.length", bitcoinPrivateKey.length);

    // // Derive TAKER's public key from private key
    // if (!bitcoinPrivateKey || bitcoinPrivateKey.length !== 64) {
    //   throw new Error("❌ Invalid BITCOIN_PRIVATE_KEY format. Must be 64 hex characters (32 bytes).");
    // }


    // const takerKeyPair = ECPair.fromPrivateKey(Buffer.from(bitcoinPrivateKey, 'hex'), { network: btcNetwork });
    const takerKeyPair = ECPair.fromWIF(bitcoinPrivateKey, btcNetwork);
    const takerPublicKey = takerKeyPair.publicKey.toString('hex');

    // Get MAKER's public key from order (no longer need to derive!)
    const makerPublicKey = order.maker.wants.publicKey;

    console.log("🔑 TAKER private key: [HIDDEN FOR SECURITY]");
    console.log("🔑 TAKER public key:", takerPublicKey);
    console.log("🔑 TAKER Bitcoin address:", bitcoinAddress);
    console.log("🔑 MAKER public key (from order):", makerPublicKey);
    console.log("🔑 MAKER Bitcoin address:", order.maker.wants.address);

    // ✅ Validate public key format
    if (!makerPublicKey || makerPublicKey.length !== 66) {
      throw new Error("❌ Invalid MAKER public key format. Must be 66 hex characters (33 bytes compressed).");
    }

    console.log("✅ Both public keys validated!");

    // Generate Bitcoin HTLC configuration with REAL keys
    const htlcConfig = {
      senderPublicKey: takerPublicKey,  // TAKER's real public key (derived from private key)
      receiverPublicKey: makerPublicKey, // MAKER's real public key (from order)
      hashlock: order.hashlock.slice(2), // Remove 0x prefix
      locktime: Math.floor(Date.now() / 1000) + order.timelock.cancellationPeriod,
      network: bitcoinNetwork,
      useSegwit: true
    };

    console.log("\n🔧 HTLC CONFIG VERIFICATION:");
    console.log("============================");
    console.log("📋 Config hashlock:", htlcConfig.hashlock);
    console.log("🔍 Config matches order:", htlcConfig.hashlock === order.hashlock.slice(2));
    console.log("📄 Full config:", JSON.stringify(htlcConfig, null, 2));

    // Create HTLC using our Bitcoin script
    const htlcOutputDir = path.join(__dirname, '..', '..', 'btc', 'output');
    const htlcConfigPath = path.join(htlcOutputDir, `htlc_config_${orderId}.json`);

    if (!fs.existsSync(htlcOutputDir)) {
      fs.mkdirSync(htlcOutputDir, { recursive: true });
    }

    fs.writeFileSync(htlcConfigPath, JSON.stringify(htlcConfig, null, 2));

    // Create HTLC directly with correct config file
    const createHTLCCommand = `ts-node btc/scripts/create-htlc.ts create ${htlcConfigPath}`;
    console.log("🔨 Creating HTLC with command:", createHTLCCommand);

    const htlcResult = execSync(createHTLCCommand, {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8'
    });

    console.log("✅ Bitcoin HTLC created successfully!");

    // Find the most recent HTLC file in the output directory
    const htlcFiles = fs.readdirSync(htlcOutputDir)
      .filter(f => f.startsWith('htlc_') && f.includes('testnet4') && f.endsWith('.json'))
      .sort((a, b) => fs.statSync(path.join(htlcOutputDir, b)).mtime.getTime() -
        fs.statSync(path.join(htlcOutputDir, a)).mtime.getTime());

    if (htlcFiles.length === 0) {
      throw new Error("❌ No HTLC output file found");
    }

    // Read the most recent HTLC file
    const htlcFilePath = path.join(htlcOutputDir, htlcFiles[0]);
    const htlcData = JSON.parse(fs.readFileSync(htlcFilePath, "utf8"));

    const htlcAddress = htlcData.address;
    const htlcScriptHash = htlcData.scriptHash;

    console.log("📍 HTLC Address:", htlcAddress);
    console.log("🔑 HTLC Script Hash:", htlcScriptHash);
    console.log("📄 HTLC File:", htlcFiles[0]);

    // Update order with TAKER and Bitcoin HTLC info
    order.taker = {
      address: taker.address,
      bitcoinAddress: bitcoinAddress
    };

    order.bitcoinHTLC = {
      address: htlcAddress,
      scriptHash: htlcScriptHash,
      amount: order.maker.wants.amount,
      network: bitcoinNetwork,
      locktime: htlcConfig.locktime
    };

    order.status = "FILLED";
    order.transactions = {
      bitcoinHTLCFunding: undefined,
      monadvmEscrowCreation: undefined,
      bitcoinHTLCClaim: undefined,
      monadvmEscrowClaim: undefined
    };

    // Save updated order
    fs.writeFileSync(orderPath, JSON.stringify(order, null, 2));

    console.log("\n✅ ORDER FILLED SUCCESSFULLY!");
    console.log("=============================");
    console.log("📄 Order ID:", orderId);
    console.log("👤 TAKER:", taker.address);
    console.log("🔗 Bitcoin HTLC:", htlcAddress);
    console.log("📊 Status:", order.status);
    console.log("💾 Updated order saved to:", orderPath);

    console.log("\n🎯 NEXT STEPS:");
    console.log("==============");
    console.log("1. 🔵 MAKER should now create Monad escrow:");
    console.log("   ORDER_ID=" + orderId + " npm run maker:escrow");
    console.log("2. 🔵 TAKER should fund the Bitcoin HTLC:");
    console.log("   ORDER_ID=" + orderId + " npm run taker:fund");
    console.log("3. 🔵 MAKER claims BTC (reveals secret):");
    console.log("   ORDER_ID=" + orderId + " npm run maker:claim");
    console.log("4. 🔵 TAKER claims ETH (using revealed secret):");
    console.log("   ORDER_ID=" + orderId + " npm run taker:claim");

    console.log("\n📋 SWAP SUMMARY:");
    console.log("================");
    console.log("🔸 MAKER provides:", ethers.formatEther(order.maker.provides.amount), "ETH");
    console.log("🔸 TAKER provides:", order.maker.wants.amount, "BTC");
    console.log("🔸 Bitcoin HTLC:", htlcAddress);
    console.log("🔸 Hashlock:", order.hashlock);
    console.log("🔸 Network:", bitcoinNetwork);

  } catch (error: any) {
    console.error("❌ Failed to create Bitcoin HTLC:", error.message);
    throw error;
  }

  return order;
}

if (require.main === module) {
  main().catch(console.error);
}

export default main; 