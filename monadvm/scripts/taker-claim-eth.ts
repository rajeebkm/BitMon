import { ethers } from "hardhat";
import { BTCEscrowSrc, IBaseEscrow } from "../typechain-types";
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';

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

  bitcoinHTLC?: {
    address: string;
    scriptHash: string;
    amount: string;
    network: string;
    locktime: number;
  };

  monadvmEscrow?: {
    address: string;
    txHash: string;
    amount: string;
    safetyDeposit: string;
    creationFee: string;
  };

  transactions?: {
    bitcoinHTLCFunding?: string;
    monadvmEscrowCreation?: string;
    bitcoinHTLCClaim?: string;
    monadvmEscrowClaim?: string;
  };
}

async function main() {
  console.log("🎯 TAKER: CLAIMING ETH (USING REVEALED SECRET)");
  console.log("===============================================");
  console.log("💡 TAKER: Using secret revealed by MAKER to claim ETH!");

  // Get order ID from environment variable or command line
  const orderId = process.env.ORDER_ID || process.argv[process.argv.length - 1];
  if (!orderId || orderId.includes('.ts')) {
    console.log("❌ Please provide order ID");
    console.log("Usage: ORDER_ID=order_1234567890 npm run taker:claim");
    console.log("   or: npm run taker:claim order_1234567890");
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

  if (order.status !== "COMPLETED") {
    throw new Error(`❌ Order status is ${order.status}, expected COMPLETED (MAKER must claim BTC first to reveal secret)`);
  }

  if (!order.taker || !order.bitcoinHTLC || !order.monadvmEscrow) {
    throw new Error("❌ Order missing required components");
  }

  if (!order.transactions?.bitcoinHTLCClaim) {
    throw new Error("❌ MAKER hasn't claimed BTC yet - secret not revealed!");
  }

  console.log("\n📋 SWAP DETAILS:");
  console.log("=================");
  console.log("🔸 MAKER:", order.maker.address);
  console.log("🔸 TAKER (you):", order.taker.address);
  console.log("🔸 MAKER provides:", ethers.formatEther(order.maker.provides.amount), "ETH");
  console.log("🔸 TAKER provides:", order.maker.wants.amount, "BTC");
  console.log("🔸 Bitcoin HTLC:", order.bitcoinHTLC.address);
  console.log("🔸 Monad Escrow:", order.monadvmEscrow.address);
  console.log("🔸 Hashlock:", order.hashlock);
  console.log("🔸 Bitcoin claim TX:", order.transactions.bitcoinHTLCClaim);

  // Load Bitcoin configuration
  const bitcoinNetwork = process.env.BITCOIN_NETWORK || "testnet4";
  const btcConfigPath = path.join(__dirname, '..', '..', 'btc', 'config', `${bitcoinNetwork}.json`);

  if (!fs.existsSync(btcConfigPath)) {
    throw new Error(`❌ Bitcoin config not found: ${btcConfigPath}`);
  }

  const btcConfig = JSON.parse(fs.readFileSync(btcConfigPath, 'utf8'));
  console.log("📄 Loaded Bitcoin config:", btcConfigPath);

  // Extract secret from Bitcoin transaction (where MAKER claimed BTC)
  console.log("\n🔍 EXTRACTING SECRET FROM BITCOIN BLOCKCHAIN:");
  console.log("==============================================");
  console.log("📡 Checking Bitcoin transaction:", order.transactions.bitcoinHTLCClaim);
  console.log("🌐 Bitcoin network:", bitcoinNetwork);
  console.log("🔍 Explorer URL:", btcConfig.explorerUrl);
  console.log("🔍 Looking for secret in transaction input script...");

  // REAL Bitcoin transaction parsing - fetch the actual transaction
  console.log("🔄 Fetching Bitcoin transaction from blockchain...");

  let extractedSecret: string;

  try {
    // Fetch the transaction hex from Bitcoin network
    const txApiUrl = `${btcConfig.rpcUrl}/tx/${order.transactions.bitcoinHTLCClaim}/hex`;
    console.log("📡 Fetching from:", txApiUrl);

    const response = await fetch(txApiUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const txHex = await response.text();
    console.log("📋 Transaction hex length:", txHex.length);
    console.log("📋 Transaction hex (first 100 chars):", txHex.substring(0, 100) + "...");

    // Parse the transaction to extract secret from witness data
    const tx = bitcoin.Transaction.fromHex(txHex);

    console.log("🔍 Transaction parsed successfully");
    console.log("🔍 Number of inputs:", tx.ins.length);
    console.log("🔍 Number of outputs:", tx.outs.length);

    // Look for the secret in the witness data of the first input
    if (tx.ins[0].witness && tx.ins[0].witness.length > 0) {
      console.log("🔍 Found witness data with", tx.ins[0].witness.length, "elements");

      // In our HTLC claim transaction, the witness stack is:
      // [signature, secret, 1, witnessScript]
      // So the secret is the second element (index 1)
      if (tx.ins[0].witness.length >= 2) {
        const secretBuffer = tx.ins[0].witness[1];
        extractedSecret = "0x" + secretBuffer.toString('hex');

        console.log("✅ SECRET EXTRACTED FROM BITCOIN BLOCKCHAIN!");
        console.log("====================");
        console.log("🔓 Raw secret buffer length:", secretBuffer.length);
        console.log("🔓 Extracted secret:", extractedSecret);
      } else {
        throw new Error("Insufficient witness elements - expected at least 2, got " + tx.ins[0].witness.length);
      }
    } else {
      throw new Error("No witness data found in transaction input");
    }

  } catch (error) {
    console.log("❌ Error fetching/parsing Bitcoin transaction:", error);
    console.log("🔄 Falling back to simulation for demo purposes...");

    // Fallback to simulation
    console.log("🔄 Simulating Bitcoin blockchain analysis...");
    await new Promise(resolve => setTimeout(resolve, 2000));
    extractedSecret = order.secret; // For demo, we already have it

    console.log("⚠️  WARNING: Using simulated secret extraction!");
    console.log("📋 In production, this MUST parse the real Bitcoin transaction.");
  }

  console.log("🔑 Expected hashlock:", order.hashlock);

  // Validate extracted secret (using SHA-256 to match Bitcoin and updated Monad contract)
  const secretBuffer = Buffer.from(extractedSecret.slice(2), 'hex'); // Remove 0x prefix
  const calculatedHashlockBuffer = crypto.createHash('sha256').update(secretBuffer).digest();
  const calculatedHashlock = "0x" + calculatedHashlockBuffer.toString('hex');

  console.log("\n🔍 SECRET VALIDATION:");
  console.log("=====================");
  console.log("🔓 Extracted secret:", extractedSecret);
  console.log("🔒 Expected hashlock:", order.hashlock);
  console.log("🧮 Calculated hashlock:", calculatedHashlock);
  console.log("🔍 Hash function: SHA-256 (Bitcoin compatible)");

  if (calculatedHashlock !== order.hashlock) {
    console.log("❌ HASHLOCK MISMATCH!");
    console.log("Expected:", order.hashlock);
    console.log("Calculated:", calculatedHashlock);
    throw new Error("❌ Extracted secret doesn't match hashlock!");
  }

  console.log("✅ Secret validation successful!");
  console.log("🎯 Secret matches! Ready to claim ETH.");

  // Connect to Monad and claim ETH
  console.log("\n💰 CLAIMING ETH FROM Monad ESCROW:");
  console.log("=================================");

  const [signer] = await ethers.getSigners();
  console.log("🔸 TAKER address:", await signer.getAddress());
  console.log("🔸 Monad Escrow:", order.monadvmEscrow.address);
  console.log("🔸 Amount to claim:", ethers.formatEther(order.maker.provides.amount), "ETH");

  // Get the BTCEscrowSrc contract (for Monad->BTC swaps)
  const BTCEscrowSrcFactory = await ethers.getContractFactory("BTCEscrowSrc");
  const escrow = BTCEscrowSrcFactory.attach(order.monadvmEscrow.address) as BTCEscrowSrc;

  console.log("\n📝 Monad Claiming Process:");
  console.log("========================");
  console.log("1. 🔍 Check escrow contract state");
  console.log("2. 🔨 Call withdraw() with revealed secret");
  console.log("3. 📡 Submit transaction to Sepolia");
  console.log("4. ⏳ Wait for confirmation");
  console.log("5. 🎉 Receive ETH!");

  try {
    // Get TAKER's ETH balance before claiming
    const balanceBefore = await ethers.provider.getBalance(await signer.getAddress());
    console.log("💰 TAKER ETH balance before:", ethers.formatEther(balanceBefore));

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
    const ESCROW_AMOUNT = BigInt(order.maker.provides.amount);

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

    // Claim ETH using revealed secret
    console.log("\n🔨 Claiming ETH...");
    const tx = await escrow.connect(signer).withdraw(extractedSecret, immutables);
    console.log("📡 Transaction submitted:", tx.hash);

    console.log("⏳ Waiting for confirmation...");
    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error("Transaction receipt is null");
    }
    console.log("✅ Transaction confirmed in block:", receipt.blockNumber);

    // Get TAKER's ETH balance after claiming
    const balanceAfter = await ethers.provider.getBalance(await signer.getAddress());
    const received = balanceAfter - balanceBefore;

    console.log("\n🎉 ETH CLAIM SUCCESSFUL!");
    console.log("=========================");
    console.log("✅ Transaction hash:", tx.hash);
    console.log("💰 ETH received:", ethers.formatEther(received));
    console.log("💰 TAKER balance after:", ethers.formatEther(balanceAfter));
    console.log("🎯 Atomic swap completed successfully!");

    // Update order with final transaction
    if (!order.transactions) {
      order.transactions = {};
    }
    order.transactions.monadvmEscrowClaim = tx.hash;
    // Status remains "COMPLETED" - MAKER already claimed BTC and revealed secret

    // Save updated order
    fs.writeFileSync(orderPath, JSON.stringify(order, null, 2));

  } catch (error) {
    console.error("❌ Error claiming ETH:", error);
    throw error;
  }

  console.log("\n🏁 ATOMIC SWAP COMPLETED!");
  console.log("==========================");
  console.log("📄 Order ID:", orderId);
  console.log("🔄 Full swap executed successfully!");
  console.log("💰 MAKER received:", order.maker.wants.amount, "BTC");
  console.log("💰 TAKER received:", ethers.formatEther(order.maker.provides.amount), "ETH");
  console.log("💾 Order saved to:", orderPath);

  console.log("\n📋 FINAL ATOMIC SWAP STATUS:");
  console.log("============================");
  console.log("✅ Step 1: Order created");
  console.log("✅ Step 2: Bitcoin HTLC created");
  console.log("✅ Step 3: Monad escrow created");
  console.log("✅ Step 4: Bitcoin HTLC funded");
  console.log("✅ Step 5: MAKER claimed BTC (secret revealed)");
  console.log("✅ Step 6: TAKER claimed ETH (using revealed secret)");

  console.log("\n🎯 ATOMIC SWAP SUMMARY:");
  console.log("=======================");
  console.log("🔸 Trade:", ethers.formatEther(order.maker.provides.amount), "ETH ↔", order.maker.wants.amount, "BTC");
  console.log("🔸 MAKER:", order.maker.address);
  console.log("🔸 TAKER:", order.taker.address);
  console.log("🔸 Bitcoin HTLC:", order.bitcoinHTLC.address);
  console.log("🔸 Monad Escrow:", order.monadvmEscrow.address);
  console.log("🔸 Secret:", extractedSecret);
  console.log("🔸 Hashlock:", order.hashlock);

  console.log("\n🔍 Verification:");
  console.log("================");
  console.log("🔸 Bitcoin claim TX:", `https://mempool.space/testnet4/tx/${order.transactions.bitcoinHTLCClaim}`);
  console.log("🔸 Monad claim TX:", `https://sepolia.etherscan.io/tx/${order.transactions.monadvmEscrowClaim}`);

  return {
    success: true,
    orderId,
    ethAmount: order.maker.provides.amount,
    btcAmount: order.maker.wants.amount,
    extractedSecret,
    claimTx: order.transactions.monadvmEscrowClaim,
    order
  };
}

if (require.main === module) {
  main().catch(console.error);
}

export default main; 