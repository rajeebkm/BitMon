#!/usr/bin/env node

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

interface AtomicSwapOrder {
  orderId: string;
  timestamp: number;
  network: string;
  chainId: number;

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
      publicKey?: string;
    };
  };

  secret: string;
  hashlock: string;

  timelock: {
    withdrawalPeriod: number;
    cancellationPeriod: number;
  };

  status: "CREATED" | "FILLED" | "COMPLETED" | "CANCELLED";

  contracts: {
    btcEscrowFactory: string;
    accessToken: string;
  };
}

async function main() {
  console.log("🚀 CREATING ATOMIC SWAP ORDER (IMMEDIATE WITHDRAWAL)");
  console.log("====================================================");

  // Get network info
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  // const networkName = chainId === 11155111 ? "sepolia" : "unknown";
  const networkName = chainId === 31337 ? "hardhat" : "unknown";

  console.log("🌐 Network:", networkName);
  console.log("🔗 Chain ID:", chainId);

  // Get maker account
  const [maker] = await ethers.getSigners();
  console.log("👤 MAKER:", maker.address);

  const makerBalance = await ethers.provider.getBalance(maker.address);
  console.log("💰 MAKER Balance:", ethers.formatEther(makerBalance), "ETH");

  // Generate secure random secret
  const secretBytes = crypto.randomBytes(32);
  const secret = "0x" + secretBytes.toString("hex");
  const hashlock = ethers.sha256(secret);

  console.log("\n🔐 CRYPTOGRAPHIC SETUP:");
  console.log("=======================");
  console.log("🔑 Secret:", secret);
  console.log("🔒 Hashlock:", hashlock);

  // Get deployed contracts
  const factoryAddress = "0x9c4da3F640f194E187eE263A3e16404f9af70761";
  const accessTokenAddress = "0xa2Ba2AdeFFf8059faAa066d6050aF70C4e5A6ccD";
  // const factoryAddress = "0x46dD29f29FB4816A4E7bd1Dc6458d1dFCA097993";
  // const accessTokenAddress = "0x0843b69626d78874Dc1A2A576102E081d8bc5438";

  console.log("\n📋 CONTRACTS:");
  console.log("=============");
  console.log("🏭 Factory:", factoryAddress);
  console.log("🎫 Access Token:", accessTokenAddress);

  // Create order with IMMEDIATE withdrawal
  const orderId = `order_${Date.now()}`;
  const timestamp = Date.now();

  const order: AtomicSwapOrder = {
    orderId,
    timestamp,
    network: networkName,
    chainId,

    maker: {
      address: maker.address,
      provides: {
        asset: "ETH",
        amount: ethers.parseEther("0.01").toString() // 0.01 ETH
      },
      wants: {
        asset: "BTC",
        amount: "0.001", // 0.001 BTC
        address: "tb1qw04epl2mtg7un7a7dle8qzhs7we0s4u2gf5jqp",
        publicKey: "02757f19d8c1ac3875a20d544a090da2590288df9b3adf6bb9cba7a0ce75374008"
      }
    },

    secret,
    hashlock,

    timelock: {
      withdrawalPeriod: 0,     // 🎯 IMMEDIATE WITHDRAWAL!
      cancellationPeriod: 3600 // 1 hour cancellation period
    },

    status: "CREATED",

    contracts: {
      btcEscrowFactory: factoryAddress,
      accessToken: accessTokenAddress
    }
  };

  console.log("\n📋 ORDER DETAILS:");
  console.log("=================");
  console.log("📄 Order ID:", orderId);
  console.log("👤 MAKER:", order.maker.address);
  console.log("💰 MAKER provides:", ethers.formatEther(order.maker.provides.amount), "ETH");
  console.log("🪙 MAKER wants:", order.maker.wants.amount, "BTC");
  console.log("🏠 Bitcoin address:", order.maker.wants.address);
  console.log("⏰ Withdrawal period:", order.timelock.withdrawalPeriod, "seconds (IMMEDIATE!)");
  console.log("⏰ Cancellation period:", order.timelock.cancellationPeriod, "seconds");

  // Save order to file
  const ordersDir = path.join(__dirname, "../../orders");
  if (!fs.existsSync(ordersDir)) {
    fs.mkdirSync(ordersDir, { recursive: true });
  }

  const orderPath = path.join(ordersDir, `${orderId}.json`);
  fs.writeFileSync(orderPath, JSON.stringify(order, null, 2));

  console.log("\n✅ ORDER CREATED SUCCESSFULLY!");
  console.log("==============================");
  console.log("📄 Order ID:", orderId);
  console.log("🔑 Secret:", secret);
  console.log("🔒 Hashlock:", hashlock);
  console.log("💾 Order saved to:", orderPath);

  console.log("\n🎯 NEXT STEPS:");
  console.log("==============");
  console.log("1. 🔵 TAKER fills order by creating Bitcoin HTLC:");
  console.log("   ORDER_ID=" + orderId + " npm run taker:fill");
  console.log("2. 🔵 MAKER creates Monad escrow:");
  console.log("   ORDER_ID=" + orderId + " npm run maker:escrow");
  console.log("3. 🔵 TAKER funds Bitcoin HTLC:");
  console.log("   ORDER_ID=" + orderId + " npm run taker:fund");
  console.log("4. 🔵 MAKER claims Bitcoin (reveals secret):");
  console.log("   ORDER_ID=" + orderId + " npm run maker:claim");
  console.log("5. 🔵 TAKER claims ETH (using revealed secret):");
  console.log("   ORDER_ID=" + orderId + " npm run taker:claim");

  console.log("\n🎉 ATOMIC SWAP READY!");
  console.log("=====================");
  console.log("🔸 Trade:", ethers.formatEther(order.maker.provides.amount), "ETH ↔", order.maker.wants.amount, "BTC");
  console.log("🔸 Withdrawal: IMMEDIATE (0 seconds)");
  console.log("🔸 Cancellation: 1 hour safety period");
  console.log("🔸 Perfect for atomic swap testing!");

  return order;
}

if (require.main === module) {
  main().catch(console.error);
}

export default main; 