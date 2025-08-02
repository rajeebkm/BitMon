import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import crypto from 'crypto';

// Initialize ECPair factory
const ECPair = ECPairFactory(ecc);

export interface HTLCConfig {
  senderPublicKey: Buffer;
  receiverPublicKey: Buffer;
  hashlock: Buffer;
  locktime: number;
  network: bitcoin.Network;
  useSegwit?: boolean;
}

export interface HTLCOutput {
  address: string;
  redeemScript: Buffer;
  lockingScript: Buffer;
  scriptHash: Buffer;
  witnessScript?: Buffer;
}

export interface HTLCTransaction {
  txid: string;
  hex: string;
  fee: number;
  vsize: number;
  witnessHash?: string;
}

export class HTLCBuilder {
  private config: HTLCConfig;

  constructor(config: HTLCConfig) {
    this.config = config;
  }

  /**
   * Creates Bitcoin HTLC script
   * Bitcoin Script: OP_IF OP_SHA256 <hashlock> OP_EQUALVERIFY <receiver_pubkey> OP_CHECKSIG OP_ELSE <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <sender_pubkey> OP_CHECKSIG OP_ENDIF
   */
  private createHTLCScript(): Buffer {
    const { senderPublicKey, receiverPublicKey, hashlock, locktime } = this.config;
    
    return bitcoin.script.compile([
      bitcoin.opcodes.OP_IF,
        bitcoin.opcodes.OP_SHA256,
        hashlock,
        bitcoin.opcodes.OP_EQUALVERIFY,
        receiverPublicKey,
        bitcoin.opcodes.OP_CHECKSIG,
      bitcoin.opcodes.OP_ELSE,
        bitcoin.script.number.encode(locktime),
        bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
        bitcoin.opcodes.OP_DROP,
        senderPublicKey,
        bitcoin.opcodes.OP_CHECKSIG,
      bitcoin.opcodes.OP_ENDIF
    ]);
  }

  /**
   * Creates HTLC output with address and scripts
   */
  createHTLC(): HTLCOutput {
    const redeemScript = this.createHTLCScript();
    const network = this.config.network;

    if (this.config.useSegwit) {
      // P2WSH (SegWit)
      const witnessScript = redeemScript;
      const scriptHash = bitcoin.crypto.sha256(witnessScript);
      const lockingScript = bitcoin.script.compile([
        bitcoin.opcodes.OP_0,
        scriptHash
      ]);
      const address = bitcoin.address.fromOutputScript(lockingScript, network);
      
      return {
        address,
        redeemScript,
        lockingScript,
        scriptHash,
        witnessScript
      };
    } else {
      // P2SH (Legacy)
      const scriptHash = bitcoin.crypto.hash160(redeemScript);
      const lockingScript = bitcoin.script.compile([
        bitcoin.opcodes.OP_HASH160,
        scriptHash,
        bitcoin.opcodes.OP_EQUAL
      ]);
      const address = bitcoin.address.fromOutputScript(lockingScript, network);
      
      return {
        address,
        redeemScript,
        lockingScript,
        scriptHash
      };
    }
  }

  /**
   * Creates funding transaction to the HTLC
   */
  createFundingTransaction(
    utxos: any[],
    amount: number,
    changeAddress: string,
    feeRate: number = 10,
    privateKey: Buffer
  ): HTLCTransaction {
    const htlc = this.createHTLC();
    const keyPair = ECPair.fromPrivateKey(privateKey);
    
    const psbt = new bitcoin.Psbt({ network: this.config.network });
    
    // Add inputs
    let totalInput = 0;
    for (const utxo of utxos) {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: Buffer.from(utxo.scriptPubKey, 'hex'),
          value: utxo.value
        }
      });
      totalInput += utxo.value;
    }
    
    // Add HTLC output
    psbt.addOutput({
      address: htlc.address,
      value: amount
    });
    
    // Calculate fee and change
    const estimatedSize = psbt.data.inputs.length * 148 + 2 * 34 + 10; // Rough estimate
    const fee = Math.ceil(estimatedSize * feeRate);
    const change = totalInput - amount - fee;
    
    if (change > 546) { // Dust threshold
      psbt.addOutput({
        address: changeAddress,
        value: change
      });
    }
    
    // Sign inputs
    for (let i = 0; i < psbt.data.inputs.length; i++) {
      psbt.signInput(i, keyPair);
    }
    
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    
    return {
      txid: tx.getId(),
      hex: tx.toHex(),
      fee,
      vsize: tx.virtualSize(),
      witnessHash: tx.getHash(true).toString('hex')
    };
  }

  /**
   * Creates claim transaction using the secret
   */
  createClaimTransaction(
    htlcTxid: string,
    htlcVout: number,
    htlcAmount: number,
    secret: Buffer,
    destinationAddress: string,
    feeRate: number = 10,
    privateKey: Buffer
  ): HTLCTransaction {
    const htlc = this.createHTLC();
    const keyPair = ECPair.fromPrivateKey(privateKey);
    
    const psbt = new bitcoin.Psbt({ network: this.config.network });
    
    if (this.config.useSegwit) {
      // P2WSH claim
      psbt.addInput({
        hash: htlcTxid,
        index: htlcVout,
        witnessUtxo: {
          script: htlc.lockingScript,
          value: htlcAmount
        },
        witnessScript: htlc.witnessScript
      });
    } else {
      // P2SH claim - NOTE: This would need the full funding transaction hex in production
      // For now, we'll focus on SegWit which is more commonly used
      throw new Error('P2SH claim transactions require the full funding transaction hex. Use SegWit (P2WSH) instead.');
    }
    
    // Calculate fee and output amount
    const estimatedSize = this.config.useSegwit ? 150 : 200; // Rough estimate
    const fee = Math.ceil(estimatedSize * feeRate);
    const outputAmount = htlcAmount - fee;
    
    psbt.addOutput({
      address: destinationAddress,
      value: outputAmount
    });
    
    // Sign the input first
    psbt.signInput(0, keyPair);
    
    // Custom finalizer for HTLC claim (revealing secret)
    psbt.finalizeInput(0, (inputIndex: number, input: any) => {
      // Get signature from the input - ensure it's DER encoded
      const rawSignature = input.partialSig[0].signature;
      
      // The signature from PSBT should already be DER encoded, but let's verify
      let signature: Buffer;
      try {
        // Try to decode the signature to verify it's properly formatted
        bitcoin.script.signature.decode(rawSignature);
        signature = rawSignature;
      } catch (error) {
        // If decoding fails, the signature might not be DER encoded
        // This shouldn't happen with modern bitcoinjs-lib, but just in case
        console.warn('⚠️  Signature not in DER format, attempting to fix...');
        throw new Error('Signature format issue - please use the direct claim script instead');
      }
      
      // Create witness stack for HTLC claim: <signature> <secret> <1> <witnessScript>
      const witnessStack = [
        signature,
        secret,
        Buffer.from([1]), // Choose the IF branch (claim path)
        htlc.witnessScript!
      ];
      
      // Return properly formatted witness
      return {
        finalScriptSig: Buffer.alloc(0), // Empty for P2WSH
        finalScriptWitness: Buffer.concat([
          Buffer.from([witnessStack.length]), // Number of witness elements
          ...witnessStack.map(item => {
            const itemBuffer = Buffer.isBuffer(item) ? item : Buffer.from(item);
            return Buffer.concat([
              Buffer.from([itemBuffer.length]), // Length of element
              itemBuffer // Element data
            ]);
          })
        ])
      };
    });
    
    const tx = psbt.extractTransaction();
    
    return {
      txid: tx.getId(),
      hex: tx.toHex(),
      fee,
      vsize: tx.virtualSize(),
      witnessHash: tx.getHash(true).toString('hex')
    };
  }

  /**
   * Creates refund transaction after locktime
   */
  createRefundTransaction(
    htlcTxid: string,
    htlcVout: number,
    htlcAmount: number,
    destinationAddress: string,
    feeRate: number = 10,
    privateKey: Buffer
  ): HTLCTransaction {
    const htlc = this.createHTLC();
    const keyPair = ECPair.fromPrivateKey(privateKey);
    
    const psbt = new bitcoin.Psbt({ network: this.config.network });
    
    if (this.config.useSegwit) {
      // P2WSH refund
      psbt.addInput({
        hash: htlcTxid,
        index: htlcVout,
        witnessUtxo: {
          script: htlc.lockingScript,
          value: htlcAmount
        },
        witnessScript: htlc.witnessScript,
        sequence: 0xfffffffe // Enable locktime
      });
    } else {
      // P2SH refund - NOTE: This would need the full funding transaction hex in production
      // For now, we'll focus on SegWit which is more commonly used
      throw new Error('P2SH refund transactions require the full funding transaction hex. Use SegWit (P2WSH) instead.');
    }
    
    // Set locktime
    psbt.setLocktime(this.config.locktime);
    
    // Calculate fee and output amount
    const estimatedSize = this.config.useSegwit ? 150 : 200; // Rough estimate
    const fee = Math.ceil(estimatedSize * feeRate);
    const outputAmount = htlcAmount - fee;
    
    psbt.addOutput({
      address: destinationAddress,
      value: outputAmount
    });
    
    // Sign the input first
    psbt.signInput(0, keyPair);
    
    // Custom finalizer for HTLC refund (after locktime)
    psbt.finalizeInput(0, (inputIndex: number, input: any) => {
      // Get signature from the input - ensure it's DER encoded
      const rawSignature = input.partialSig[0].signature;
      
      // The signature from PSBT should already be DER encoded, but let's verify
      let signature: Buffer;
      try {
        // Try to decode the signature to verify it's properly formatted
        bitcoin.script.signature.decode(rawSignature);
        signature = rawSignature;
      } catch (error) {
        // If decoding fails, the signature might not be DER encoded
        console.warn('⚠️  Signature not in DER format, attempting to fix...');
        throw new Error('Signature format issue - please use the direct refund script instead');
      }
      
      // Create witness stack for HTLC refund: <signature> <0> <witnessScript>
      const witnessStack = [
        signature,
        Buffer.from([0]), // Choose the ELSE branch (refund path)
        htlc.witnessScript!
      ];
      
      // Return properly formatted witness
      return {
        finalScriptSig: Buffer.alloc(0), // Empty for P2WSH
        finalScriptWitness: Buffer.concat([
          Buffer.from([witnessStack.length]), // Number of witness elements
          ...witnessStack.map(item => {
            const itemBuffer = Buffer.isBuffer(item) ? item : Buffer.from(item);
            return Buffer.concat([
              Buffer.from([itemBuffer.length]), // Length of element
              itemBuffer // Element data
            ]);
          })
        ])
      };
    });
    
    const tx = psbt.extractTransaction();
    
    return {
      txid: tx.getId(),
      hex: tx.toHex(),
      fee,
      vsize: tx.virtualSize(),
      witnessHash: tx.getHash(true).toString('hex')
    };
  }

  /**
   * Extracts secret from a claim transaction
   */
  static extractSecretFromTransaction(txHex: string, witnessScript: Buffer): Buffer | null {
    try {
      const tx = bitcoin.Transaction.fromHex(txHex);
      
      // Check witness data for SegWit
      if (tx.ins[0].witness && tx.ins[0].witness.length > 0) {
        // In SegWit HTLC claim, secret is the second witness element
        const secret = tx.ins[0].witness[1];
        return secret;
      }
      
      // Check script signature for legacy P2SH
      if (tx.ins[0].script && tx.ins[0].script.length > 0) {
        const scriptSig = bitcoin.script.decompile(tx.ins[0].script);
        if (scriptSig && scriptSig.length > 1) {
          // In P2SH HTLC claim, secret is typically the second element
          const secret = scriptSig[1] as Buffer;
          return secret;
        }
      }
      
      return null;
    } catch (error) {
      console.error('Error extracting secret:', error);
      return null;
    }
  }

  /**
   * Validates an HTLC address
   */
  static validateHTLCAddress(address: string, network: bitcoin.Network): boolean {
    try {
      bitcoin.address.toOutputScript(address, network);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generates a random secret
   */
  static generateSecret(): Buffer {
    return crypto.randomBytes(32);
  }

  /**
   * Computes SHA256 hash of secret
   */
  static hashSecret(secret: Buffer): Buffer {
    return crypto.createHash('sha256').update(secret).digest();
  }
} 