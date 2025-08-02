/**
 * Mempool.space API Client
 * 
 * Provides a reliable interface to Bitcoin blockchain data
 * using the Mempool.space API for both mainnet and testnet4.
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';

export interface MempoolConfig {
  baseUrl: string;
  network: 'mainnet' | 'testnet4';
  timeout: number;
}

export interface UTXO {
  txid: string;
  vout: number;
  value: number;
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

export interface TransactionDetails {
  txid: string;
  version: number;
  locktime: number;
  size: number;
  weight: number;
  fee: number;
  vin: Array<{
    txid: string;
    vout: number;
    scriptSig: {
      asm: string;
      hex: string;
    };
    witness?: string[];
    sequence: number;
  }>;
  vout: Array<{
    value: number;
    scriptPubKey: {
      asm: string;
      hex: string;
      type: string;
      address?: string;
    };
  }>;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

export interface AddressStats {
  address: string;
  chain_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
  mempool_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
}

export class MempoolAPI {
  private config: MempoolConfig;

  constructor(network: 'mainnet' | 'testnet4' = 'testnet4') {
    this.config = {
      baseUrl: network === 'mainnet'
        ? 'https://mempool.space/api'
        : 'https://mempool.space/testnet4/api',
      network,
      timeout: 10000
    };
  }

  /**
   * Make HTTP request to Mempool.space API
   */
  private async makeRequest(endpoint: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, this.config.baseUrl);
      const client = url.protocol === 'https:' ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Monad-BTC-Atomic-Swap/1.0.0',
          'Accept': 'application/json'
        },
        timeout: this.config.timeout
      };

      const req = client.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              const jsonData = JSON.parse(data);
              resolve(jsonData);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          } catch (error) {
            reject(new Error(`JSON Parse Error: ${error}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Request Error: ${error.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });
  }

  /**
   * Get UTXOs for a Bitcoin address
   */
  async getAddressUTXOs(address: string): Promise<UTXO[]> {
    try {
      const utxos = await this.makeRequest(`/address/${address}/utxo`);
      return utxos.map((utxo: any) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        confirmed: utxo.status.confirmed,
        block_height: utxo.status.block_height,
        block_hash: utxo.status.block_hash,
        block_time: utxo.status.block_time
      }));
    } catch (error) {
      throw new Error(`Failed to get UTXOs for ${address}: ${error}`);
    }
  }

  /**
   * Get transaction details
   */
  async getTransaction(txid: string): Promise<TransactionDetails> {
    try {
      const tx = await this.makeRequest(`/tx/${txid}`);
      return tx;
    } catch (error) {
      throw new Error(`Failed to get transaction ${txid}: ${error}`);
    }
  }

  /**
   * Get address statistics
   */
  async getAddressStats(address: string): Promise<AddressStats> {
    try {
      const stats = await this.makeRequest(`/address/${address}`);
      return stats;
    } catch (error) {
      throw new Error(`Failed to get stats for ${address}: ${error}`);
    }
  }

  /**
   * Get current network fee estimates
   */
  async getFeeEstimates(): Promise<{ [key: string]: number }> {
    try {
      const fees = await this.makeRequest('/v1/fees/recommended');
      return fees;
    } catch (error) {
      throw new Error(`Failed to get fee estimates: ${error}`);
    }
  }

  /**
   * Broadcast a transaction
   */
  async broadcastTransaction(txHex: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL('/tx', this.config.baseUrl);
      const client = url.protocol === 'https:' ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(txHex),
          'User-Agent': 'Monad-BTC-Atomic-Swap/1.0.0'
        },
        timeout: this.config.timeout
      };

      const req = client.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data.trim()); // Transaction ID
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Broadcast Error: ${error.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Broadcast timeout'));
      });

      req.write(txHex);
      req.end();
    });
  }

  /**
   * Get current block height
   */
  async getBlockHeight(): Promise<number> {
    try {
      const tip = await this.makeRequest('/blocks/tip/height');
      return tip;
    } catch (error) {
      throw new Error(`Failed to get block height: ${error}`);
    }
  }

  /**
   * Check if transaction is confirmed
   */
  async isTransactionConfirmed(txid: string, minConfirmations: number = 1): Promise<boolean> {
    try {
      const tx = await this.getTransaction(txid);
      if (!tx.status.confirmed) {
        return false;
      }

      if (minConfirmations <= 1) {
        return true;
      }

      const currentHeight = await this.getBlockHeight();
      const confirmations = currentHeight - (tx.status.block_height || 0) + 1;
      return confirmations >= minConfirmations;
    } catch (error) {
      throw new Error(`Failed to check confirmation for ${txid}: ${error}`);
    }
  }

  /**
   * Extract secret from Bitcoin transaction input script
   * Used when claiming from HTLC to reveal the secret
   */
  extractSecretFromTransaction(tx: TransactionDetails): string | null {
    try {
      for (const input of tx.vin) {
        if (input.scriptSig && input.scriptSig.hex) {
          // Parse script to find secret
          const scriptHex = input.scriptSig.hex;

          // Look for 32-byte secret in the script
          // This is a simplified implementation - in production,
          // you'd need proper script parsing
          const secretMatch = scriptHex.match(/([a-f0-9]{64})/i);
          if (secretMatch) {
            return secretMatch[1];
          }
        }

        // Check witness data for SegWit transactions
        if (input.witness) {
          for (const witnessElement of input.witness) {
            if (witnessElement.length === 64) { // 32 bytes = 64 hex chars
              return witnessElement;
            }
          }
        }
      }

      return null;
    } catch (error) {
      throw new Error(`Failed to extract secret: ${error}`);
    }
  }

  /**
   * Get network configuration
   */
  getNetworkConfig(): MempoolConfig {
    return { ...this.config };
  }
}

/**
 * Create Mempool API client for the specified network
 */
export function createMempoolClient(network: 'mainnet' | 'testnet4' = 'testnet4'): MempoolAPI {
  return new MempoolAPI(network);
}

/**
 * Test connection to Mempool.space API
 */
export async function testMempoolConnection(network: 'mainnet' | 'testnet4' = 'testnet4'): Promise<boolean> {
  try {
    const client = createMempoolClient(network);
    const height = await client.getBlockHeight();
    console.log(`✅ Connected to ${network} Mempool.space API - Block height: ${height}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to connect to ${network} Mempool.space API:`, error);
    return false;
  }
} 