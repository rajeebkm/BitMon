#!/usr/bin/env node

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import type { BTCEscrowFactory, BTCEscrowDst } from "../monadvm/typechain-types";

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

  transactions?: {
    monadvmEscrowCreation?: string;
    bitcoinHTLCCreation?: string;
    bitcoinHTLCClaim?: string;
    monadvmEscrowClaim?: string;
  };

  bitcoinHTLC?: {
    address: string;
    txHash: string;
    amount: string;
    timelock: string;
  };
}

async function main() {
  console.log("🔄 TAKER: CREATING Monad ESCROW (REVERSE FLOW)");
  console.log("============================================");
  console.log("💡 TAKER: Creating Monad escrow with ETH for BTC→ETH swap");

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

  if (order.status !== "FUNDED") {
    throw new Error(`❌ Order status is ${order.status}, expected FUNDED (MAKER should have created and funded Bitcoin HTLC first)`);
  }

  if (!order.bitcoinHTLC) {
    throw new Error("❌ Bitcoin HTLC not found in order. MAKER should create and fund Bitcoin HTLC first.");
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
    taker = signers[0]; // Default to first signer
  }

  console.log("👤 TAKER (Monad):", taker.address);
  const takerBalance = await ethers.provider.getBalance(taker.address);
  console.log("💰 TAKER Balance:", ethers.formatEther(takerBalance), "ETH");

  // TAKER's Bitcoin details (in reverse flow, TAKER will receive BTC)
  const takerBitcoinAddress = "tb1qw04epl2mtg7un7a7dle8qzhs7we0s4u2gf5jqp";

  console.log("\n📋 REVERSE ORDER DETAILS:");
  console.log("=========================");
  console.log("🔸 MAKER (Monad):", order.maker.address);
  console.log("🔸 MAKER (Bitcoin):", order.maker.bitcoinAddress);
  console.log("🔸 TAKER (Monad):", taker.address);
  console.log("🔸 TAKER (Bitcoin):", takerBitcoinAddress);
  console.log("🔸 MAKER provides:", order.maker.provides.amount, "BTC");
  console.log("🔸 TAKER provides:", ethers.formatEther(order.maker.wants.amount), "ETH");
  console.log("🔸 Bitcoin HTLC (already created):", order.bitcoinHTLC.address);
  console.log("🔸 Hashlock:", order.hashlock);

  // Connect to BTC Escrow Factory
  const factory = await ethers.getContractAt("BTCEscrowFactory", order.contracts.btcEscrowFactory) as BTCEscrowFactory;
  console.log("🔗 Connected to BTC Escrow Factory:", await factory.getAddress());

  // Setup escrow parameters
  const now = Math.floor(Date.now() / 1000);
  const SAFETY_DEPOSIT = ethers.parseEther("0.001"); // Small safety deposit
  const CREATION_FEE = await factory.creationFee();
  const ESCROW_AMOUNT = BigInt(order.maker.wants.amount);
  const TOTAL_REQUIRED = ESCROW_AMOUNT + SAFETY_DEPOSIT + CREATION_FEE;

  console.log("\n💰 ESCROW PARAMETERS:");
  console.log("=====================");
  console.log("🔸 Escrow Amount:", ethers.formatEther(ESCROW_AMOUNT), "ETH");
  console.log("🔸 Safety Deposit:", ethers.formatEther(SAFETY_DEPOSIT), "ETH");
  console.log("🔸 Creation Fee:", ethers.formatEther(CREATION_FEE), "ETH");
  console.log("🔸 Total Required:", ethers.formatEther(TOTAL_REQUIRED), "ETH");

  // Check balance
  if (takerBalance < TOTAL_REQUIRED) {
    throw new Error(`❌ Insufficient balance! Need ${ethers.formatEther(TOTAL_REQUIRED)} ETH, have ${ethers.formatEther(takerBalance)} ETH`);
  }

  // Create escrow immutables for BTCEscrowDst (destination escrow for BTC→ETH)
  const dstWithdrawal = order.timelock.withdrawalPeriod;
  const dstPublicWithdrawal = order.timelock.withdrawalPeriod * 2;
  const dstCancellation = order.timelock.cancellationPeriod;

  // Pack timelocks
  const timelocks = (BigInt(now) << 224n) |
    (BigInt(dstCancellation) << 64n) |
    (BigInt(dstPublicWithdrawal) << 32n) |
    BigInt(dstWithdrawal);

  // Convert addresses to uint256 for immutables
  const immutables = {
    orderHash: ethers.keccak256(ethers.toUtf8Bytes(orderId)),
    hashlock: order.hashlock,
    maker: BigInt(order.maker.address),      // MAKER (Monad address)
    taker: BigInt(taker.address),            // TAKER (Monad address) 
    token: BigInt(ethers.ZeroAddress),       // ETH
    amount: ESCROW_AMOUNT,
    safetyDeposit: SAFETY_DEPOSIT,
    timelocks: timelocks
  };

  console.log("\n🔨 Creating Monad Destination Escrow (BTCEscrowDst)...");
  console.log("====================================================");
  console.log("🔸 Using BTCEscrowDst for BTC→ETH flow");
  console.log("🔸 TAKER locks ETH, MAKER will claim later");
  console.log("🔸 Maker Address (uint256):", immutables.maker.toString());
  console.log("🔸 Taker Address (uint256):", immutables.taker.toString());
  console.log("🔸 Token Address (uint256):", immutables.token.toString());
  console.log("🔸 Hashlock:", immutables.hashlock);

  // Test addressOfEscrowDst first
  try {
    const escrowAddress = await factory.addressOfEscrowDst(immutables);
    console.log("🏠 Calculated Escrow Address:", escrowAddress);
  } catch (error) {
    console.log("❌ Error calculating escrow address:", error);
    throw error;
  }

  try {
    // Get current gas price and increase it
    const feeData = await ethers.provider.getFeeData();
    const baseGasPrice = feeData.gasPrice || ethers.parseUnits("2", "gwei");
    const highGasPrice = baseGasPrice * 5n; // 5x higher gas price

    console.log("⛽ Gas price:", ethers.formatUnits(highGasPrice, "gwei"), "gwei");

    // Create destination escrow (TAKER provides ETH)
    const tx = await factory.connect(taker).createDstEscrow(immutables, {
      value: TOTAL_REQUIRED,
      gasPrice: highGasPrice
    });

    console.log("⏳ Transaction submitted:", tx.hash);
    const receipt = await tx.wait();

    if (!receipt) {
      throw new Error("❌ Transaction failed");
    }

    console.log("✅ Transaction confirmed!");
    console.log("⛽ Gas used:", receipt.gasUsed.toString());

    // Calculate escrow address
    const escrowAddress = await factory.addressOfEscrowDst(immutables);
    console.log("🏠 Escrow Address:", escrowAddress);

    // Update order with Monad escrow info and taker details
    order.monadvmEscrow = {
      address: escrowAddress,
      txHash: tx.hash,
      amount: ESCROW_AMOUNT.toString(),
      safetyDeposit: SAFETY_DEPOSIT.toString(),
      creationFee: CREATION_FEE.toString()
    };

    order.taker = {
      address: taker.address,
      bitcoinAddress: takerBitcoinAddress
    };

    order.status = "FILLED";

    if (!order.transactions) {
      order.transactions = {};
    }
    order.transactions.monadvmEscrowCreation = tx.hash;

    // Save updated order
    fs.writeFileSync(orderPath, JSON.stringify(order, null, 2));

    console.log("\n✅ Monad ESCROW CREATED SUCCESSFULLY!");
    console.log("===================================");
    console.log("📄 Order ID:", orderId);
    console.log("👤 TAKER (Monad):", taker.address);
    console.log("👤 TAKER (Bitcoin):", takerBitcoinAddress);
    console.log("🏠 Escrow Address:", escrowAddress);
    console.log("📝 TX Hash:", tx.hash);
    console.log("💾 Updated order saved to:", orderPath);

    console.log("\n🎯 NEXT STEPS (REVERSE FLOW):");
    console.log("=============================");
    console.log("1. 🔵 MAKER claims ETH (reveals secret):");
    console.log("   ORDER_ID=" + orderId + " npm run reverse:maker:claim");
    console.log("2. 🔵 TAKER claims BTC (using revealed secret):");
    console.log("   ORDER_ID=" + orderId + " npm run reverse:taker:claim");

    console.log("\n📋 REVERSE SWAP STATUS:");
    console.log("=======================");
    console.log("🔸 Monad Escrow:", escrowAddress);
    console.log("🔸 TAKER locked:", ethers.formatEther(ESCROW_AMOUNT), "ETH");
    console.log("🔸 Waiting for MAKER to create Bitcoin HTLC with", order.maker.provides.amount, "BTC");

    console.log("\n🔍 Block Explorer:");
    console.log("==================");
    console.log("🔸 Monad Escrow:", `https://sepolia.etherscan.io/address/${escrowAddress}`);

  } catch (error: any) {
    console.error("❌ Failed to create Monad escrow:", error.message);
    throw error;
  }

  return order;
}

if (require.main === module) {
  main().catch(console.error);
}

export default main; 