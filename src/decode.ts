import { formatEther } from 'viem';

/** EIP-7708: every ETH transfer emits an ERC-20-style Transfer log from this system address. */
export const SYSTEM_ADDRESS = '0xfffffffffffffffffffffffffffffffffffffffe';
/** keccak256('Transfer(address,address,uint256)') */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export type TransferKind = 'top-level' | 'internal';

export interface Transfer {
  from: string;
  to: string;
  valueWei: bigint;
  txHash: string;
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  timestamp: number | null;
}

export type ClassifiedTransfer = Transfer & { kind: TransferKind };

/** A log as returned by JSON-RPC (hex strings). */
export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string | null;
  blockNumber: string | null;
  blockHash: string | null;
  logIndex: string | null;
  blockTimestamp?: string | null;
  removed?: boolean;
}

const topicToAddress = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();

export function decodeTransferLog(log: RpcLog): Transfer | null {
  if (log.address.toLowerCase() !== SYSTEM_ADDRESS) return null;
  if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  if (!log.transactionHash || !log.blockNumber || !log.blockHash || !log.logIndex) return null;
  return {
    from: topicToAddress(log.topics[1]!),
    to: topicToAddress(log.topics[2]!),
    valueWei: log.data === '0x' ? 0n : BigInt(log.data),
    txHash: log.transactionHash.toLowerCase(),
    blockNumber: Number(log.blockNumber),
    blockHash: log.blockHash.toLowerCase(),
    logIndex: Number(log.logIndex),
    timestamp: log.blockTimestamp ? Number(log.blockTimestamp) : null,
  };
}

export const weiToEth = (wei: bigint): number => Number(formatEther(wei));
