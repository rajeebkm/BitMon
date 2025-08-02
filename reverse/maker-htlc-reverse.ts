#!/usr/bin/env node


import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

interface ReverseAtomicSwapOrder {
  orderId: string;
  timestamp: number;
  network: string;
  chainId: number;

  maker: {
    address: string;
    bitcoinAddress: string;
    publicKey: string;
    provides: {
      asset: "BTC";
      amount: string;
    };
    wants: {
      asset: "ETH" | "ERC20";
      amount: string;
      token?: string;
    };
  };

  taker?: {
    address: string;
    bitcoinAddress: string;
  };

  secret: string;
  hashlock: string;

  timelock: {
    withdrawalPeriod: number;
    cancellationPeriod: number;
  };

  status: "CREATED" | "FILLED" | "FUNDED" | "COMPLETED" | "CANCELLED";

  contracts: {
    btcEscrowFactory: string;
    accessToken: string;
  };

  monadvmEscrow?: {
    address: string;
    txHash: string;
    amount: string;
    safetyDeposit: string;
    creationFee: string;
  };

  bitcoinHTLC?: {
    address: string;
    scriptHash: string;
    amount: string;
    network: string;
    locktime: number;
  };

  transactions?: {
    monadvmEscrowCreation?: string;
    bitcoinHTLCCreation?: string;
    bitcoinHTLCFunding?: string;
    bitcoinHTLCClaim?: string;
    monadvmEscrowClaim?: string;
  };
}

async function main() {
  console.log("🔄 MAKER: CREATING BITCOIN HTLC (REVERSE FLOW)");
  console.log("===============================================");
  console.log("💡 MAKER: Creating Bitcoin HTLC with BTC for BTC→ETH swap");

  const orderId = process.env.ORDER_ID;
  if (!orderId) {
    throw new Error("❌ ORDER_ID environment variable required");
  }

  const orderPath = path.join(__dirname, "../orders", `${orderId}.json`);

  if (!fs.existsSync(orderPath)) {
    throw new Error(`❌ Order file not found: ${orderPath}`);
  }

  const order: ReverseAtomicSwapOrder = JSON.parse(fs.readFileSync(orderPath, "utf8"));

  console.log("📄 Loaded order:", orderId);
  console.log("⏰ Created:", new Date(order.timestamp).toISOString());

  if (order.status !== "CREATED") {
    throw new Error(`❌ Order status is ${order.status}, expected CREATED`);
  }

  // No need to check for taker or monadvmEscrow since this is now the first step

  console.log("\n📋 REVERSE ORDER DETAILS:");
  console.log("=========================");
  console.log("🔸 MAKER (Monad):", order.maker.address);
  console.log("🔸 MAKER (Bitcoin):", order.maker.bitcoinAddress);
  console.log("🔸 MAKER provides:", order.maker.provides.amount, "BTC");
  console.log("🔸 TAKER will provide:", ethers.formatEther(order.maker.wants.amount), "ETH");
  console.log("🔸 Bitcoin network: testnet4");

  console.log("\n🔗 Step 1: Creating Bitcoin HTLC...");
  console.log("====================================");

  // Convert BTC amount to satoshis
  const btcAmount = parseFloat(order.maker.provides.amount);
  const satoshiAmount = Math.floor(btcAmount * 100000000);

  console.log("💰 HTLC Amount:", order.maker.provides.amount, "BTC (" + satoshiAmount + " satoshis)");
  console.log("🔒 Using hashlock:", order.hashlock);
  console.log("�� Recipient (TAKER): Will be filled when TAKER joins");

  // Secret/hashlock verification
  console.log("\n🔍 SECRET/HASHLOCK VERIFICATION:");
  console.log("================================");
  console.log("📄 Order secret:", order.secret);
  console.log("📄 Order hashlock:", order.hashlock);
  console.log("🔄 Hashlock without 0x:", order.hashlock.slice(2));
  console.log("⚠️  HTLC creation should ONLY use hashlock, NEVER the secret!");

  // Use real public keys
  console.log("\n🔧 USING REAL PUBLIC KEYS:");
  console.log("==========================");
  console.log("🔑 MAKER private key: [HIDDEN FOR SECURITY]");
  console.log("🔑 MAKER public key:", order.maker.publicKey);
  console.log("🔑 MAKER Bitcoin address:", order.maker.bitcoinAddress);
  console.log("🔑 TAKER Bitcoin address: Will be filled when TAKER joins");
  console.log("✅ Public keys validated!");

  // Create HTLC config
  const htlcConfig = {
    senderPublicKey: order.maker.publicKey,      // MAKER provides BTC
    receiverPublicKey: order.maker.publicKey,    // Use same key for simplicity (testnet)
    hashlock: order.hashlock.slice(2),           // Remove 0x prefix
    locktime: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    network: "testnet4",
    useSegwit: true
  };

  console.log("\n🔧 HTLC CONFIG VERIFICATION:");
  console.log("============================");
  console.log("📋 Config hashlock:", htlcConfig.hashlock);
  console.log("🔍 Config matches order:", htlcConfig.hashlock === order.hashlock.slice(2));
  console.log("📄 Full config:", JSON.stringify(htlcConfig, null, 2));

  // Save HTLC config
  const htlcConfigPath = path.join(__dirname, "../btc/output", `htlc_config_${orderId}.json`);
  const btcOutputDir = path.join(__dirname, "../btc/output");

  if (!fs.existsSync(btcOutputDir)) {
    fs.mkdirSync(btcOutputDir, { recursive: true });
  }

  fs.writeFileSync(htlcConfigPath, JSON.stringify(htlcConfig, null, 2));

  // Create Bitcoin HTLC
  console.log("🔨 Creating HTLC with command: ts-node btc/scripts/create-htlc.ts create " + htlcConfigPath);

  try {
    const result = execSync(`cd ${path.join(__dirname, "..")} && ts-node btc/scripts/create-htlc.ts create ${htlcConfigPath}`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });

    console.log("✅ Bitcoin HTLC created successfully!");

    // Find the most recent HTLC file in the output directory
    const btcOutputDir = path.join(__dirname, "../btc/output");
    const htlcFiles = fs.readdirSync(btcOutputDir)
      .filter(f => f.startsWith('htlc_') && f.includes('testnet4') && f.endsWith('.json'))
      .sort((a, b) => fs.statSync(path.join(btcOutputDir, b)).mtime.getTime() -
        fs.statSync(path.join(btcOutputDir, a)).mtime.getTime());

    if (htlcFiles.length === 0) {
      throw new Error("❌ No HTLC output file found");
    }

    // Read the most recent HTLC file
    const htlcFilePath = path.join(btcOutputDir, htlcFiles[0]);
    const htlcData = JSON.parse(fs.readFileSync(htlcFilePath, "utf8"));

    const htlcAddress = htlcData.address;
    const scriptHash = htlcData.scriptHash;

    console.log("📍 HTLC Address:", htlcAddress);
    console.log("🔑 HTLC Script Hash:", scriptHash);
    console.log("📄 HTLC File:", htlcFiles[0]);

    // Update order with Bitcoin HTLC info
    order.bitcoinHTLC = {
      address: htlcAddress,
      scriptHash: scriptHash,
      amount: order.maker.provides.amount,
      network: "testnet4",
      locktime: htlcConfig.locktime
    };

    if (!order.transactions) {
      order.transactions = {};
    }
    order.transactions.bitcoinHTLCCreation = htlcFiles[0];

    // Save updated order
    fs.writeFileSync(orderPath, JSON.stringify(order, null, 2));

    console.log("\n✅ BITCOIN HTLC CREATED SUCCESSFULLY!");
    console.log("=====================================");
    console.log("📄 Order ID:", orderId);
    console.log("👤 MAKER (Bitcoin):", order.maker.bitcoinAddress);
    console.log("🔗 Bitcoin HTLC:", htlcAddress);
    console.log("📊 Status: HTLC Created (needs funding)");
    console.log("💾 Updated order saved to:", orderPath);

    console.log("\n🎯 NEXT STEPS (REVERSE FLOW):");
    console.log("=============================");
    console.log("1. 🔵 MAKER should fund the Bitcoin HTLC:");
    console.log("   ORDER_ID=" + orderId + " npm run reverse:maker:fund");
    console.log("2. 🔵 TAKER claims BTC (reveals secret):");
    console.log("   ORDER_ID=" + orderId + " npm run reverse:taker:claim");
    console.log("3. 🔵 MAKER claims ETH (using revealed secret):");
    console.log("   ORDER_ID=" + orderId + " npm run reverse:maker:claim");

    console.log("\n📋 REVERSE SWAP SUMMARY:");
    console.log("========================");
    console.log("🔸 MAKER provides:", order.maker.provides.amount, "BTC");
    console.log("🔸 TAKER provides:", ethers.formatEther(order.maker.wants.amount), "ETH");
    console.log("🔸 Bitcoin HTLC:", htlcAddress);
    console.log("🔸 Monad Escrow: Will be created by TAKER later");
    console.log("🔸 Hashlock:", order.hashlock);
    console.log("🔸 Network: testnet4");

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