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
  console.log("🔄 MAKER: FUNDING BITCOIN HTLC (REVERSE FLOW)");
  console.log("==============================================");
  console.log("💡 MAKER: Funding Bitcoin HTLC with real BTC");

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

  if (!order.bitcoinHTLC) {
    throw new Error("❌ Bitcoin HTLC not found in order. Create HTLC first.");
  }

  // No need to check for taker or monadvmEscrow since this is step 2 of corrected flow

  console.log("\n📋 REVERSE SWAP DETAILS:");
  console.log("========================");
  console.log("🔸 MAKER (Monad):", order.maker.address);
  console.log("🔸 MAKER (Bitcoin):", order.maker.bitcoinAddress);
  console.log("🔸 MAKER provides:", order.maker.provides.amount, "BTC");
  console.log("🔸 TAKER will provide:", ethers.formatEther(order.maker.wants.amount), "ETH");
  console.log("🔸 Bitcoin HTLC:", order.bitcoinHTLC.address);
  console.log("🔸 Monad Escrow: Will be created by TAKER later");

  console.log("\n💰 Funding Details:");
  console.log("===================");
  const btcAmount = parseFloat(order.maker.provides.amount);
  const satoshiAmount = Math.floor(btcAmount * 100000000);

  console.log("🔸 BTC Amount:", order.maker.provides.amount, "BTC");
  console.log("🔸 Satoshis:", satoshiAmount.toLocaleString());
  console.log("🔸 HTLC Address:", order.bitcoinHTLC.address);

  console.log("\n🔧 Bitcoin Funding Requirements:");
  console.log("=================================");
  console.log("⚠️  To fund this HTLC with REAL Bitcoin, you need:");
  console.log("   1. 🪙 Bitcoin testnet coins (get from faucet)");
  console.log("   2. 🔑 Private key for your Bitcoin address");
  console.log("   3. 📡 Bitcoin node or API access");

  console.log("\n🌐 Bitcoin Testnet Faucets:");
  console.log("   • https://coinfaucet.eu/en/btc-testnet/");
  console.log("   • https://testnet-faucet.com/btc-testnet/");
  console.log("   • https://bitcoinfaucet.uo1.net/");

  console.log("\n📝 Required Environment Variables:");
  console.log("   • BITCOIN_PRIVATE_KEY (your Bitcoin private key)");
  console.log("   • BITCOIN_ADDRESS (your Bitcoin address)");
  console.log("   • BITCOIN_NETWORK (testnet4)");

  // Check for Bitcoin environment variables
  const bitcoinPrivateKey = process.env.BITCOIN_PRIVATE_KEY;
  const bitcoinAddress = process.env.BITCOIN_ADDRESS;
  const bitcoinNetwork = process.env.BITCOIN_NETWORK || "testnet4";

  if (!bitcoinPrivateKey || !bitcoinAddress) {
    console.log("\n❌ Bitcoin credentials not found!");
    console.log("==================================");
    console.log("Please set the following environment variables:");
    console.log("export BITCOIN_PRIVATE_KEY=your_private_key_here");
    console.log("export BITCOIN_ADDRESS=your_address_here");
    console.log("export BITCOIN_NETWORK=testnet4");
    throw new Error("❌ Bitcoin credentials required for funding");
  }

  console.log("\n✅ Bitcoin credentials found!");
  console.log("🔸 Network:", bitcoinNetwork);
  console.log("🔸 Your Bitcoin Address:", bitcoinAddress);
  console.log("🔸 Target HTLC Address:", order.bitcoinHTLC.address);

  console.log("\n🔨 CREATING REAL BITCOIN TRANSACTION...");
  console.log("=======================================");
  console.log("🔄 Executing Bitcoin transaction...");

  const fundCommand = `cd ${path.join(__dirname, "..")} && ts-node btc/scripts/fund-htlc.ts --address=${order.bitcoinHTLC.address} --amount=${satoshiAmount} --network=${bitcoinNetwork}`;
  console.log("Command:", fundCommand);

  try {
    const result = execSync(fundCommand, {
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        BITCOIN_PRIVATE_KEY: bitcoinPrivateKey,
        BITCOIN_ADDRESS: bitcoinAddress,
        BITCOIN_NETWORK: bitcoinNetwork
      }
    });

    console.log("✅ Bitcoin transaction result:");
    console.log(result);

    // Extract transaction ID from the result
    const lines = result.split('\n');
    let txId = '';

    for (const line of lines) {
      if (line.includes('TXID:') || line.includes('Transaction ID:')) {
        txId = line.split(':')[1]?.trim() || '';
        break;
      }
    }

    if (!txId) {
      // Try to find transaction ID in different format
      for (const line of lines) {
        if (line.match(/[a-f0-9]{64}/)) {
          txId = line.match(/[a-f0-9]{64}/)?.[0] || '';
          break;
        }
      }
    }

    console.log("\n🎉 REAL BITCOIN TRANSACTION CREATED!");
    console.log("====================================");
    console.log("📝 TX ID:", txId);
    console.log("💰 Amount:", order.maker.provides.amount, "BTC");
    console.log("📍 HTLC Address:", order.bitcoinHTLC.address);
    console.log("🔍 View on Explorer: https://mempool.space/testnet4/tx/" + txId);

    // Update order with funding transaction
    if (!order.transactions) {
      order.transactions = {};
    }
    order.transactions.bitcoinHTLCFunding = txId;
    order.status = "FUNDED";

    // Save updated order
    fs.writeFileSync(orderPath, JSON.stringify(order, null, 2));

    console.log("\n✅ REAL FUNDING COMPLETE!");
    console.log("=========================");
    console.log("📄 Order ID:", orderId);
    console.log("📊 Status updated to: FUNDED");
    console.log("📝 Real TX recorded:", txId);
    console.log("💾 Order saved to:", orderPath);

    console.log("\n🎯 NEXT STEPS (REVERSE FLOW):");
    console.log("=============================");
    console.log("1. 🔵 TAKER creates Monad escrow with ETH:");
    console.log("   ORDER_ID=" + orderId + " npm run reverse:taker:escrow");
    console.log("2. 🔵 MAKER claims ETH (reveals secret):");
    console.log("   ORDER_ID=" + orderId + " npm run reverse:maker:claim");
    console.log("3. 🔵 TAKER claims BTC (using revealed secret):");
    console.log("   ORDER_ID=" + orderId + " npm run reverse:taker:claim");

  } catch (error: any) {
    console.error("❌ Failed to fund Bitcoin HTLC:", error.message);
    throw error;
  }

  return order;
}

if (require.main === module) {
  main().catch(console.error);
}

export default main; 