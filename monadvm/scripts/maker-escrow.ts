import { ethers } from "hardhat";
import * as fs from 'fs';
import * as path from 'path';
import { BTCEscrowFactory } from "../typechain-types";

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
    };
  };

  // Taker info
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

  // Bitcoin HTLC info
  bitcoinHTLC?: {
    address: string;
    script: string;
    amount: string;
    network: string;
    locktime: number;
  };

  // Monad escrow info (added by this script)
  monadvmEscrow?: {
    address: string;
    txHash: string;
    amount: string;
    safetyDeposit: string;
    creationFee: string;
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
  console.log("🎯 CREATING Monad ESCROW");
  console.log("======================");
  console.log("💡 MAKER: Creating Monad escrow to match Bitcoin HTLC");

  // Get order ID from environment variable or command line
  const orderId = process.env.ORDER_ID || process.argv[process.argv.length - 1];
  if (!orderId || orderId.includes('.ts')) {
    console.log("❌ Please provide order ID");
    console.log("Usage: ORDER_ID=order_1234567890 npm run maker:escrow");
    console.log("   or: npm run maker:escrow order_1234567890");
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

  if (order.status !== "FILLED") {
    throw new Error(`❌ Order status is ${order.status}, expected FILLED`);
  }

  if (!order.taker || !order.bitcoinHTLC) {
    throw new Error("❌ Order missing taker or Bitcoin HTLC info");
  }

  // Get network info
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  if (chainId !== order.chainId) {
    throw new Error(`❌ Network mismatch! Order is for chain ${order.chainId}, you're on ${chainId}`);
  }

  // Get maker account
  const signers = await ethers.getSigners();
  let maker: any;

  if (process.env.MAKER_ADDRESS) {
    const targetAddress = process.env.MAKER_ADDRESS;
    maker = signers.find(s => s.address.toLowerCase() === targetAddress.toLowerCase());
    if (!maker) {
      throw new Error(`❌ MAKER_ADDRESS ${targetAddress} not found in available signers`);
    }
  } else {
    maker = signers[0]; // Default to first signer
  }

  console.log("👤 MAKER:", maker.address);
  const makerBalance = await ethers.provider.getBalance(maker.address);
  console.log("💰 MAKER Balance:", ethers.formatEther(makerBalance), "ETH");

  // Verify maker matches order
  if (maker.address.toLowerCase() !== order.maker.address.toLowerCase()) {
    throw new Error(`❌ Maker address mismatch! Expected ${order.maker.address}, got ${maker.address}`);
  }

  console.log("\n📋 ORDER DETAILS:");
  console.log("=================");
  console.log("🔸 MAKER:", order.maker.address);
  console.log("🔸 TAKER:", order.taker.address);
  console.log("🔸 MAKER provides:", ethers.formatEther(order.maker.provides.amount), "ETH");
  console.log("🔸 TAKER provides:", order.maker.wants.amount, "BTC");
  console.log("🔸 Bitcoin HTLC:", order.bitcoinHTLC.address);
  console.log("🔸 Hashlock:", order.hashlock);

  // Connect to BTC Escrow Factory
  const factory = await ethers.getContractAt("BTCEscrowFactory", order.contracts.btcEscrowFactory) as BTCEscrowFactory;
  console.log("🔗 Connected to BTC Escrow Factory:", await factory.getAddress());

  // Setup escrow parameters
  const now = Math.floor(Date.now() / 1000);
  const SAFETY_DEPOSIT = ethers.parseEther("0.001"); // Small safety deposit
  const CREATION_FEE = await factory.creationFee();
  const ESCROW_AMOUNT = BigInt(order.maker.provides.amount);
  const TOTAL_REQUIRED = ESCROW_AMOUNT + SAFETY_DEPOSIT + CREATION_FEE;

  console.log("\n💰 ESCROW PARAMETERS:");
  console.log("=====================");
  console.log("🔸 Escrow Amount:", ethers.formatEther(ESCROW_AMOUNT), "ETH");
  console.log("🔸 Safety Deposit:", ethers.formatEther(SAFETY_DEPOSIT), "ETH");
  console.log("🔸 Creation Fee:", ethers.formatEther(CREATION_FEE), "ETH");
  console.log("🔸 Total Required:", ethers.formatEther(TOTAL_REQUIRED), "ETH");
  console.log("🔸 ESCROW_AMOUNT (wei):", ESCROW_AMOUNT.toString());
  console.log("🔸 SAFETY_DEPOSIT (wei):", SAFETY_DEPOSIT.toString());
  console.log("🔸 CREATION_FEE (wei):", CREATION_FEE.toString());
  console.log("🔸 TOTAL_REQUIRED (wei):", TOTAL_REQUIRED.toString());

  // Check balance
  if (makerBalance < TOTAL_REQUIRED) {
    throw new Error(`❌ Insufficient balance! Need ${ethers.formatEther(TOTAL_REQUIRED)} ETH, have ${ethers.formatEther(makerBalance)} ETH`);
  }

  // Create escrow immutables
  const dstWithdrawal = order.timelock.withdrawalPeriod;
  const dstPublicWithdrawal = order.timelock.withdrawalPeriod * 2;
  const dstCancellation = order.timelock.cancellationPeriod;

  // Pack timelocks
  const timelocks = (BigInt(now) << 224n) |
    (BigInt(dstCancellation) << 64n) |
    (BigInt(dstPublicWithdrawal) << 32n) |
    BigInt(dstWithdrawal);

  // Convert addresses to Address type (uint256)
  const immutables = {
    orderHash: ethers.keccak256(ethers.toUtf8Bytes(orderId)),
    hashlock: order.hashlock,
    maker: BigInt(maker.address),           // Convert to uint256
    taker: BigInt(order.taker.address),     // Convert to uint256
    token: BigInt(ethers.ZeroAddress),      // Convert to uint256 (ETH)
    amount: ESCROW_AMOUNT,
    safetyDeposit: SAFETY_DEPOSIT,
    timelocks: timelocks
  };

  console.log("\n🔨 Creating Monad Escrow...");
  console.log("=========================");
  console.log("🔸 Maker Address (uint256):", immutables.maker.toString());
  console.log("🔸 Taker Address (uint256):", immutables.taker.toString());
  console.log("🔸 Token Address (uint256):", immutables.token.toString());
  console.log("🔸 Hashlock:", immutables.hashlock);

  // Test addressOfEscrowSrc first
  try {
    const escrowAddress = await factory.addressOfEscrowSrc(immutables);
    console.log("🏠 Calculated Escrow Address:", escrowAddress);
  } catch (error) {
    console.log("❌ Error calculating escrow address:", error);
    throw error;
  }

  try {
    // Get current gas price and increase it significantly
    const feeData = await ethers.provider.getFeeData();
    const baseGasPrice = feeData.gasPrice || ethers.parseUnits("2", "gwei");
    const highGasPrice = baseGasPrice * 10n; // 10x higher gas price

    console.log("⛽ Gas price:", ethers.formatUnits(highGasPrice, "gwei"), "gwei");

    // Create source escrow (MAKER provides ETH)
    const tx = await factory.connect(maker).createSrcEscrow(immutables, {
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
    const escrowAddress = await factory.addressOfEscrowSrc(immutables);
    console.log("🏠 Escrow Address:", escrowAddress);

    // Update order with Monad escrow info
    order.monadvmEscrow = {
      address: escrowAddress,
      txHash: tx.hash,
      amount: ESCROW_AMOUNT.toString(),
      safetyDeposit: SAFETY_DEPOSIT.toString(),
      creationFee: CREATION_FEE.toString()
    };

    if (!order.transactions) {
      order.transactions = {};
    }
    order.transactions.monadvmEscrowCreation = tx.hash;

    // Save updated order
    fs.writeFileSync(orderPath, JSON.stringify(order, null, 2));

    console.log("\n✅ Monad ESCROW CREATED SUCCESSFULLY!");
    console.log("===================================");
    console.log("📄 Order ID:", orderId);
    console.log("👤 MAKER:", maker.address);
    console.log("🏠 Escrow Address:", escrowAddress);
    console.log("📝 TX Hash:", tx.hash);
    console.log("💾 Updated order saved to:", orderPath);

    console.log("\n🎯 NEXT STEPS:");
    console.log("==============");
    console.log("1. 🔵 TAKER should fund the Bitcoin HTLC:");
    console.log("   ORDER_ID=" + orderId + " npm run taker:fund");
    console.log("2. 🔵 MAKER claims BTC (reveals secret):");
    console.log("   ORDER_ID=" + orderId + " npm run maker:claim");
    console.log("3. 🔵 TAKER claims ETH (using revealed secret):");
    console.log("   ORDER_ID=" + orderId + " npm run taker:claim");

    console.log("\n📋 SWAP STATUS:");
    console.log("===============");
    console.log("🔸 Monad Escrow:", escrowAddress);
    console.log("🔸 Bitcoin HTLC:", order.bitcoinHTLC.address);
    console.log("🔸 Both sides ready for atomic swap!");

    console.log("\n🔍 Block Explorers:");
    console.log("===================");
    console.log("🔸 Monad Escrow:", `https://sepolia.etherscan.io/address/${escrowAddress}`);
    console.log("🔸 Bitcoin HTLC:", `https://mempool.space/testnet4/address/${order.bitcoinHTLC.address}`);

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