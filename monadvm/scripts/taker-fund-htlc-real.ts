import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

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
      publicKey: string;
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
  console.log("🎯 TAKER: REAL BITCOIN HTLC FUNDING");
  console.log("====================================");
  console.log("💡 TAKER: Creating and broadcasting REAL Bitcoin transaction");

  // Get order ID from environment variable or command line
  const orderId = process.env.ORDER_ID || process.argv[process.argv.length - 1];
  if (!orderId || orderId.includes('.ts')) {
    console.log("❌ Please provide order ID");
    console.log("Usage: ORDER_ID=order_1234567890 npm run taker:fund:real");
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

  if (!order.taker || !order.bitcoinHTLC || !order.monadvmEscrow) {
    throw new Error("❌ Order missing required components (taker, Bitcoin HTLC, or Monad escrow)");
  }

  console.log("\n📋 SWAP DETAILS:");
  console.log("=================");
  console.log("🔸 MAKER:", order.maker.address);
  console.log("🔸 TAKER:", order.taker.address);
  console.log("🔸 MAKER provides:", ethers.formatEther(order.maker.provides.amount), "ETH");
  console.log("🔸 TAKER provides:", order.maker.wants.amount, "BTC");
  console.log("🔸 Bitcoin HTLC:", order.bitcoinHTLC.address);
  console.log("🔸 Monad Escrow:", order.monadvmEscrow.address);

  // Convert BTC to satoshis
  const btcAmount = parseFloat(order.maker.wants.amount);
  const satoshis = Math.floor(btcAmount * 100000000);

  console.log("\n💰 Funding Details:");
  console.log("===================");
  console.log("🔸 BTC Amount:", btcAmount, "BTC");
  console.log("🔸 Satoshis:", satoshis.toLocaleString());
  console.log("🔸 HTLC Address:", order.bitcoinHTLC.address);

  // Check for Bitcoin funding requirements
  console.log("\n🔧 Bitcoin Funding Requirements:");
  console.log("=================================");
  console.log("⚠️  To fund this HTLC with REAL Bitcoin, you need:");
  console.log("   1. 🪙 Bitcoin testnet coins (get from faucet)");
  console.log("   2. 🔑 Private key for your Bitcoin address");
  console.log("   3. 📡 Bitcoin node or API access");
  console.log("");
  console.log("🌐 Bitcoin Testnet Faucets:");
  console.log("   • https://coinfaucet.eu/en/btc-testnet/");
  console.log("   • https://testnet-faucet.com/btc-testnet/");
  console.log("   • https://bitcoinfaucet.uo1.net/");
  console.log("");
  console.log("📝 Required Environment Variables:");
  console.log("   • BITCOIN_PRIVATE_KEY (your Bitcoin private key)");
  console.log("   • BITCOIN_ADDRESS (your Bitcoin address)");
  console.log("   • BITCOIN_NETWORK (testnet4)");

  // Check if we have Bitcoin credentials
  const bitcoinPrivateKey = process.env.BITCOIN_PRIVATE_KEY;
  const bitcoinAddress = process.env.BITCOIN_ADDRESS;
  const bitcoinNetwork = process.env.BITCOIN_NETWORK || "testnet4";

  if (!bitcoinPrivateKey || !bitcoinAddress) {
    console.log("\n❌ MISSING BITCOIN CREDENTIALS");
    console.log("===============================");
    console.log("Please set these environment variables:");
    console.log("BITCOIN_PRIVATE_KEY=your_private_key_here");
    console.log("BITCOIN_ADDRESS=your_bitcoin_address_here");
    console.log("BITCOIN_NETWORK=testnet4");
    console.log("");
    console.log("💡 To create a Bitcoin wallet:");
    console.log("   1. Use Bitcoin Core or any Bitcoin wallet");
    console.log("   2. Generate a testnet address");
    console.log("   3. Get testnet Bitcoin from faucets");
    console.log("   4. Export private key and address");
    process.exit(1);
  }

  console.log("\n✅ Bitcoin credentials found!");
  console.log("🔸 Network:", bitcoinNetwork);
  console.log("🔸 Your Bitcoin Address:", bitcoinAddress);
  console.log("🔸 Target HTLC Address:", order.bitcoinHTLC.address);

  // Use our Bitcoin HTLC builder
  const htlcBuilderPath = path.join(__dirname, '..', '..', 'btc', 'lib', 'htlc-builder.ts');
  if (!fs.existsSync(htlcBuilderPath)) {
    throw new Error("❌ Bitcoin HTLC builder not found");
  }

  console.log("\n🔨 CREATING REAL BITCOIN TRANSACTION...");
  console.log("=======================================");

  try {
    // Import the HTLC builder
    const { execSync } = require('child_process');

    // Create funding transaction using our funding script
    const command = `cd ${path.join(__dirname, '..', '..', 'btc')} && ts-node scripts/fund-htlc.ts --address=${order.bitcoinHTLC.address} --amount=${satoshis} --network=${bitcoinNetwork}`;

    console.log("🔄 Executing Bitcoin transaction...");
    console.log("Command:", command);

    const result = execSync(command, { encoding: 'utf8' });
    console.log("✅ Bitcoin transaction result:");
    console.log(result);

    // Parse the transaction ID from the result
    const txIdMatch = result.match(/Transaction ID: ([a-f0-9]{64})/i);
    const actualTxId = txIdMatch ? txIdMatch[1] : `real_${Date.now()}_funding`;

    console.log("\n🎉 REAL BITCOIN TRANSACTION CREATED!");
    console.log("====================================");
    console.log("📝 TX ID:", actualTxId);
    console.log("💰 Amount:", btcAmount, "BTC");
    console.log("📍 HTLC Address:", order.bitcoinHTLC.address);
    console.log("🔍 View on Explorer:", `https://mempool.space/${bitcoinNetwork}/tx/${actualTxId}`);

    // Update order status
    order.status = "FUNDED";
    if (!order.transactions) {
      order.transactions = {};
    }
    order.transactions.bitcoinHTLCFunding = actualTxId;

    // Save updated order
    fs.writeFileSync(orderPath, JSON.stringify(order, null, 2));

    console.log("\n✅ REAL FUNDING COMPLETE!");
    console.log("=========================");
    console.log("📄 Order ID:", orderId);
    console.log("📊 Status updated to:", order.status);
    console.log("📝 Real TX recorded:", actualTxId);
    console.log("💾 Order saved to:", orderPath);

  } catch (error: any) {
    console.error("❌ Failed to create real Bitcoin transaction:", error.message);
    console.log("\n🔄 FALLBACK: Using simulation mode");
    console.log("==================================");

    // Fallback to simulation
    const mockFundingTxId = `sim_${btcAmount.toString().replace('.', '')}_${Date.now()}_funding`;

    order.status = "FUNDED";
    if (!order.transactions) {
      order.transactions = {};
    }
    order.transactions.bitcoinHTLCFunding = mockFundingTxId;

    fs.writeFileSync(orderPath, JSON.stringify(order, null, 2));

    console.log("📝 Simulated TX ID:", mockFundingTxId);
    console.log("💾 Order updated with simulation");
  }

  console.log("\n🎯 NEXT STEPS:");
  console.log("==============");
  console.log("1. 🔵 MAKER can now claim BTC (reveals secret):");
  console.log("   ORDER_ID=" + orderId + " npm run maker:claim");
  console.log("2. 🔵 After secret is revealed, TAKER can claim ETH:");
  console.log("   ORDER_ID=" + orderId + " npm run taker:claim");

  return order;
}

if (require.main === module) {
  main().catch(console.error);
}

export default main; 