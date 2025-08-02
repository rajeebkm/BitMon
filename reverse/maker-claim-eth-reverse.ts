#!/usr/bin/env node

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import type { BTCEscrowDst, IBaseEscrow } from "../monadvm/typechain-types";
import * as crypto from "crypto";

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
  console.log("🔄 MAKER: CLAIMING ETH (REVEALS SECRET - REVERSE FLOW)");
  console.log("======================================================");
  console.log("💡 MAKER: Claiming ETH from Monad escrow reveals the secret!");

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
    throw new Error("❌ Bitcoin HTLC not found in order");
  }

  if (!order.taker || !order.monadvmEscrow) {
    throw new Error("❌ Order missing taker or Monad escrow info");
  }

  if (!order.transactions?.bitcoinHTLCFunding) {
    throw new Error("❌ Bitcoin HTLC not funded yet");
  }

  console.log("\n📋 REVERSE SWAP DETAILS:");
  console.log("========================");
  console.log("🔸 MAKER (you):", order.maker.address);
  console.log("🔸 TAKER:", order.taker.address);
  console.log("🔸 MAKER will receive:", ethers.formatEther(order.maker.wants.amount), "ETH");
  console.log("🔸 TAKER will receive:", order.maker.provides.amount, "BTC");
  console.log("🔸 Bitcoin HTLC:", order.bitcoinHTLC.address);
  console.log("🔸 Monad Escrow:", order.monadvmEscrow.address);
  console.log("🔸 Hashlock:", order.hashlock);
  console.log("🔸 Secret (MAKER knows):", order.secret);

  // Secret validation
  console.log("\n🔍 SECRET VALIDATION:");
  console.log("======================");
  const secretBuffer = Buffer.from(order.secret.slice(2), 'hex');
  const calculatedHashlockBuffer = crypto.createHash('sha256').update(secretBuffer).digest();
  const calculatedHashlock = "0x" + calculatedHashlockBuffer.toString('hex');

  console.log("🔒 Order secret:", order.secret);
  console.log("🔑 Order hashlock:", order.hashlock);
  console.log("🧮 Calculated hashlock:", calculatedHashlock);
  console.log("✅ Secret matches hashlock:", calculatedHashlock === order.hashlock);

  // Connect to Monad and claim ETH
  console.log("\n💰 CLAIMING ETH FROM Monad ESCROW:");
  console.log("=================================");

  const [signer] = await ethers.getSigners();
  console.log("🔸 MAKER address:", await signer.getAddress());
  console.log("🔸 Monad Escrow:", order.monadvmEscrow.address);
  console.log("🔸 Amount to claim:", ethers.formatEther(order.maker.wants.amount), "ETH");

  // Verify maker matches order
  if (signer.address.toLowerCase() !== order.maker.address.toLowerCase()) {
    throw new Error(`❌ Maker address mismatch! Expected ${order.maker.address}, got ${signer.address}`);
  }

  // Get the BTCEscrowDst contract (for BTC→Monad reverse flow)
  const BTCEscrowDstFactory = await ethers.getContractFactory("BTCEscrowDst");
  const escrow = BTCEscrowDstFactory.attach(order.monadvmEscrow.address) as BTCEscrowDst;

  console.log("\n📝 Monad Claiming Process:");
  console.log("========================");
  console.log("1. 🔍 Check escrow contract state");
  console.log("2. 🔨 Call withdraw() with secret");
  console.log("3. 📡 Submit transaction to Sepolia");
  console.log("4. ⏳ Wait for confirmation");
  console.log("5. 🎉 Receive ETH and reveal secret!");

  try {
    // Get MAKER's ETH balance before claiming
    const balanceBefore = await ethers.provider.getBalance(await signer.getAddress());
    console.log("💰 MAKER ETH balance before:", ethers.formatEther(balanceBefore));

    // Construct Immutables struct EXACTLY as it was during escrow creation
    // Get the exact escrow creation timestamp from the blockchain
    console.log("🔍 Getting escrow creation timestamp from blockchain...");
    const escrowCreationTx = await ethers.provider.getTransaction(order.monadvmEscrow.txHash);
    if (!escrowCreationTx) {
      throw new Error(`❌ Could not find escrow creation transaction: ${order.monadvmEscrow.txHash}`);
    }
    const escrowCreationReceipt = await escrowCreationTx.wait();
    if (!escrowCreationReceipt) {
      throw new Error(`❌ Could not get escrow creation receipt`);
    }
    const escrowCreationBlock = await ethers.provider.getBlock(escrowCreationReceipt.blockHash);
    if (!escrowCreationBlock) {
      throw new Error(`❌ Could not get escrow creation block`);
    }
    const escrowCreationTime = escrowCreationBlock.timestamp;

    console.log(`📅 Escrow creation TX: ${order.monadvmEscrow.txHash}`);
    console.log(`📅 Escrow creation block: ${escrowCreationReceipt.blockNumber}`);
    console.log(`📅 Escrow creation time: ${escrowCreationTime} (${new Date(escrowCreationTime * 1000).toISOString()})`);

    const SAFETY_DEPOSIT = ethers.parseEther("0.001"); // Same as escrow creation
    const ESCROW_AMOUNT = BigInt(order.maker.wants.amount);

    // Calculate timelocks exactly the same way as in escrow creation
    const dstWithdrawal = order.timelock.withdrawalPeriod;
    const dstPublicWithdrawal = order.timelock.withdrawalPeriod * 2;
    const dstCancellation = order.timelock.cancellationPeriod;

    // Pack timelocks (same calculation as escrow creation, using exact creation time)
    const timelocks = (BigInt(escrowCreationTime) << 224n) |
      (BigInt(dstCancellation) << 64n) |
      (BigInt(dstPublicWithdrawal) << 32n) |
      BigInt(dstWithdrawal);

    const immutables: IBaseEscrow.ImmutablesStruct = {
      orderHash: ethers.keccak256(ethers.toUtf8Bytes(orderId)),
      hashlock: order.hashlock,
      maker: BigInt(order.maker.address),           // Convert to uint256
      taker: BigInt(order.taker.address),           // Convert to uint256
      token: BigInt(ethers.ZeroAddress),            // Convert to uint256 (ETH)
      amount: ESCROW_AMOUNT,
      safetyDeposit: SAFETY_DEPOSIT,
      timelocks: timelocks
    };

    console.log("\n🔍 CONSTRUCTED IMMUTABLES:");
    console.log("==========================");
    console.log("📄 Order ID:", orderId);
    console.log("✅ Order hash:", immutables.orderHash);
    console.log("🔒 Hashlock:", immutables.hashlock);
    console.log("👤 Maker (address):", order.maker.address);
    console.log("👤 Maker (uint256):", immutables.maker.toString());
    console.log("👤 Taker (address):", order.taker.address);
    console.log("👤 Taker (uint256):", immutables.taker.toString());
    console.log("🏦 Token (uint256):", immutables.token.toString(), "(0 = ETH)");
    console.log("💰 Amount:", ethers.formatEther(immutables.amount), "ETH");
    console.log("🔐 Safety Deposit:", ethers.formatEther(immutables.safetyDeposit), "ETH");
    console.log("⏰ Timelocks (packed):", immutables.timelocks.toString());
    console.log("🕐 Escrow creation time:", escrowCreationTime, "(" + new Date(escrowCreationTime * 1000).toISOString() + ")");
    console.log("🕐 Withdrawal period:", dstWithdrawal, "seconds");
    console.log("🕐 Public withdrawal:", dstPublicWithdrawal, "seconds");
    console.log("🕐 Cancellation period:", dstCancellation, "seconds");

    // Claim ETH using secret
    console.log("\n🔨 Claiming ETH...");
    const tx = await escrow.connect(signer).withdraw(order.secret, immutables);
    console.log("📡 Transaction submitted:", tx.hash);

    console.log("⏳ Waiting for confirmation...");
    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error("Transaction receipt is null");
    }
    console.log("✅ Transaction confirmed in block:", receipt.blockNumber);

    // Get MAKER's ETH balance after claiming
    const balanceAfter = await ethers.provider.getBalance(await signer.getAddress());
    const received = balanceAfter - balanceBefore;

    console.log("\n🎉 ETH CLAIM SUCCESSFUL!");
    console.log("=========================");
    console.log("✅ Transaction hash:", tx.hash);
    console.log("💰 ETH received:", ethers.formatEther(received));
    console.log("💰 MAKER balance after:", ethers.formatEther(balanceAfter));
    console.log("🔓 Secret revealed on Monad blockchain!");

    console.log("\n🔥 CRITICAL: SECRET IS NOW PUBLIC!");
    console.log("===================================");
    console.log("🔓 Secret:", order.secret);
    console.log("📡 Visible on Monad blockchain in transaction:", tx.hash);
    console.log("👁️ Anyone can now see this secret and use it!");
    console.log("🔗 Verify secret in transaction: https://sepolia.etherscan.io/tx/" + tx.hash);

    // Update order with final transaction
    if (!order.transactions) {
      order.transactions = {};
    }
    order.transactions.monadvmEscrowClaim = tx.hash;
    order.status = "COMPLETED";

    // Save updated order
    fs.writeFileSync(orderPath, JSON.stringify(order, null, 2));

    console.log("\n✅ MAKER ETH CLAIM COMPLETE!");
    console.log("=============================");
    console.log("📄 Order ID:", orderId);
    console.log("📊 Status: COMPLETED");
    console.log("💰 ETH claimed:", ethers.formatEther(order.maker.wants.amount), "ETH");
    console.log("📝 Claim TX:", tx.hash);
    console.log("💾 Order saved to:", orderPath);

    console.log("\n🎯 NEXT STEP FOR TAKER:");
    console.log("=======================");
    console.log("🔓 Secret is now public on Monad blockchain!");
    console.log("🔸 TAKER can extract secret and claim BTC:");
    console.log("   ORDER_ID=" + orderId + " npm run reverse:taker:claim");
    console.log("🔸 TAKER just needs to extract secret from Monad TX:", tx.hash);

    console.log("\n📋 REVERSE ATOMIC SWAP STATUS:");
    console.log("==============================");
    console.log("✅ Step 1: Order created (MAKER wants ETH, provides BTC)");
    console.log("✅ Step 2: MAKER created Bitcoin HTLC");
    console.log("✅ Step 3: MAKER funded Bitcoin HTLC");
    console.log("✅ Step 4: TAKER created Monad escrow with ETH");
    console.log("✅ Step 5: MAKER claimed ETH (secret revealed)");
    console.log("🔵 Step 6: TAKER extract secret and claim BTC");

    console.log("\n🔍 Verification:");
    console.log("================");
    console.log("🔸 Monad claim TX: https://sepolia.etherscan.io/tx/" + tx.hash);
    console.log("🔸 Bitcoin HTLC: https://mempool.space/testnet4/address/" + order.bitcoinHTLC.address);
    console.log("🔸 Secret revealed in Monad TX input data!");

    return {
      success: true,
      orderId,
      ethAmount: order.maker.wants.amount,
      btcAmount: order.maker.provides.amount,
      revealedSecret: order.secret,
      claimTx: tx.hash,
      order
    };

  } catch (error) {
    console.error("❌ Error claiming ETH:", error);
    throw error;
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export default main; 