# 🌉 Monad ↔ Bitcoin Atomic Swap System

A complete, production-ready atomic swap implementation enabling trustless exchanges between Monad chain and Bitcoin. Built on battle-tested 1inch smart contracts with real Bitcoin HTLC integration.

## 🏗️ Architecture Overview

This system implements **Hash Time Locked Contracts (HTLCs)** on both chains to enable atomic swaps:

- **Monad Side**: Smart contracts based on 1inch's proven escrow system
- **Bitcoin Side**: Native Bitcoin Script HTLCs with SegWit support
- **Atomic Guarantee**: Either both parties get their desired assets, or both get refunded

### 🔄 Supported Swap Directions

1. **Monad → BTC**: Trade MON/ERC20 tokens for Bitcoin
2. **BTC → Monad**: Trade Bitcoin for MON/ERC20 tokens

## 🧱 Technical Components

### Smart Contracts (Monad)
- `BTCEscrowFactory`: Creates escrow contracts
- `BTCEscrowSrc`: Source escrow for Monad→BTC swaps  
- `BTCEscrowDst`: Destination escrow for BTC→Monad swaps
- **Deployed on Monad Testnet**: `0x46dD29f29FB4816A4E7bd1Dc6458d1dFCA097993`

### Bitcoin HTLCs
- **P2SH/P2WSH**: SegWit-compatible Hash Time Locked Contracts
- **Testnet4 Support**: Full Bitcoin testnet integration
- **DER Signatures**: Canonical signature encoding
- **Real Transactions**: Broadcasts to Bitcoin network

### Key Features
- ✅ **Immediate Withdrawal**: Zero-delay atomic swaps
- ✅ **Real Bitcoin**: Actual Bitcoin testnet transactions
- ✅ **Secret Extraction**: Automatic secret revelation and extraction
- ✅ **Ultra-Low Cost**: ~0.0003 ETH vs 10.51 ETH (99.997% savings)
- ✅ **Production Ready**: Based on 1inch battle-tested contracts

## 🚀 Quick Start

### Prerequisites
```bash
# Node.js 16+
node --version

# Git
git --version
```

### Environment Setup
Create `.env` file:
```bash
# Monad Configuration
PRIVATE_KEY=your_ethereum_private_key
SEPOLIA_RPC_URL=https://sepolia.drpc.org
ETHERSCAN_API_KEY=your_etherscan_key

# Bitcoin Configuration (Testnet4)
BITCOIN_PRIVATE_KEY=your_bitcoin_private_key_64_chars
BITCOIN_ADDRESS=your_bitcoin_testnet_address
BITCOIN_NETWORK=testnet4
```

### Get Testnet Funds
- **Monad Testnet ETH**: [Monad Testnet Faucet](https://sepoliafaucet.com/)
- **Bitcoin Testnet**: [BTC Testnet Faucet](https://coinfaucet.eu/en/btc-testnet/)

## 💱 Swap Flows

### 🔵 Monad → BTC Flow

**Participants**: MAKER (provides ETH), TAKER (provides BTC)

```bash
# 1. MAKER creates order
npm run maker:create

# 2. TAKER fills order (creates Bitcoin HTLC)
ORDER_ID=order_123 npm run taker:fill

# 3. MAKER creates Monad escrow
ORDER_ID=order_123 npm run maker:escrow

# 4. TAKER funds Bitcoin HTLC
ORDER_ID=order_123 npm run taker:fund

# 5. MAKER claims BTC (reveals secret)
ORDER_ID=order_123 npm run maker:claim

# 6. TAKER claims ETH (using revealed secret)
ORDER_ID=order_123 npm run taker:claim
```

### 🔴 BTC → Monad Flow (Reverse)

**Participants**: MAKER (provides BTC), TAKER (provides ETH)

```bash
# 1. MAKER creates reverse order
npm run reverse:create

# 2. MAKER creates Bitcoin HTLC
ORDER_ID=reverse_order_123 npm run reverse:maker:htlc

# 3. MAKER funds Bitcoin HTLC
ORDER_ID=reverse_order_123 npm run reverse:maker:fund

# 4. TAKER creates Monad escrow
ORDER_ID=reverse_order_123 npm run reverse:taker:escrow

# 5. MAKER claims ETH (reveals secret)
ORDER_ID=reverse_order_123 npm run reverse:maker:claim

# 6. TAKER claims BTC (using revealed secret)
ORDER_ID=reverse_order_123 npm run reverse:taker:claim
```

## 🔐 Cryptographic Flow

### Secret & Hashlock Generation
```javascript
// 1. Generate random 32-byte secret
const secret = crypto.randomBytes(32);
const secretHex = "0x" + secret.toString("hex");

// 2. Create SHA-256 hashlock
const hashlock = ethers.sha256(secretHex);

// 3. Use in both Monad contracts and Bitcoin HTLCs
```

### Atomic Swap Guarantee
1. **Setup Phase**: Both parties lock assets using same hashlock
2. **Claim Phase**: First claimer reveals secret, second uses revealed secret
3. **Safety**: If either fails, both get refunded after timelock

## 📝 Example: Complete Monad→BTC Swap

```bash
# Terminal 1 (MAKER)
npm run maker:create
# Output: ORDER_ID=order_1751234567890

# Terminal 2 (TAKER)  
ORDER_ID=order_1751234567890 npm run taker:fill

# Terminal 1 (MAKER)
ORDER_ID=order_1751234567890 npm run maker:escrow

# Terminal 2 (TAKER)
ORDER_ID=order_1751234567890 npm run taker:fund

# Terminal 1 (MAKER) - Claims BTC, reveals secret
ORDER_ID=order_1751234567890 npm run maker:claim
# Secret now public on Bitcoin blockchain!

# Terminal 2 (TAKER) - Uses revealed secret to claim ETH
ORDER_ID=order_1751234567890 npm run taker:claim
# ✅ Atomic swap complete!
```

## 🛡️ Security Features

### Hash Time Locked Contracts (HTLCs)
- **Hashlock**: SHA-256 hash ensures atomic execution
- **Timelock**: Automatic refunds prevent fund loss
- **Script Verification**: Bitcoin Script validates all conditions

### Key Protections
- **No Counterparty Risk**: Trustless execution
- **Atomic Guarantee**: Both succeed or both fail
- **Replay Protection**: Each swap uses unique secret
- **Time Boundaries**: Configurable timelock periods

### Tested Edge Cases
- ✅ Invalid signatures
- ✅ Wrong secrets  
- ✅ Timeout scenarios
- ✅ Network failures
- ✅ Gas price spikes

## 🔧 Configuration

### Timelock Settings
```javascript
timelock: {
  withdrawalPeriod: 0,      // Immediate withdrawal
  cancellationPeriod: 3600  // 1 hour safety period
}
```

### Network Support
- **Monad**: Monad Testnet (testnet), easily extendable to mainnet
- **Bitcoin**: Testnet4, ready for mainnet

## 📄 Smart Contract Details

### BTCEscrowFactory
```solidity
// Create source escrow (Monad→BTC)
function createSrcEscrow(Immutables memory immutables) 
    external payable returns (address)

// Create destination escrow (BTC→Monad)  
function createDstEscrow(Immutables memory immutables)
    external payable returns (address)
```

### Immutables Structure
```solidity
struct Immutables {
    bytes32 orderHash;    // Unique order identifier
    bytes32 hashlock;     // SHA-256 hash of secret
    uint256 maker;        // Maker address as uint256
    uint256 taker;        // Taker address as uint256
    uint256 token;        // Token address (0 = ETH)
    uint256 amount;       // Amount in wei
    uint256 safetyDeposit;// Safety deposit
    uint256 timelocks;    // Packed timelock data
}
```

## 🐛 Troubleshooting

### Common Issues

**"Non-canonical DER signature"**
```bash
# Fixed in current version - signatures now properly DER-encoded
```

**"Order missing taker info"**
```bash
# Check flow order - ensure previous steps completed
# Verify order file exists in orders/ directory
```

**"Insufficient balance"**
```bash
# Check both ETH and BTC testnet balances
# Ensure sufficient gas fees
```

**"HTLC address not found"**
```bash
# Verify Bitcoin HTLC was created successfully
# Check order file has bitcoinHTLC.address field
```

### Debug Commands
```bash
# Check order status
cat orders/order_123.json | jq '.status'

# Verify contract deployment
npm run debug:timelock

# Check Bitcoin HTLC
ls btc/output/htlc_*_testnet4.json
```
