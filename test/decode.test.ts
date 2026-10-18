import { describe, expect, it } from 'vitest';
import { decodeTransferLog, weiToEth, type RpcLog } from '../src/decode.js';

const sepoliaLog: RpcLog = {
  address: '0xfffffffffffffffffffffffffffffffffffffffe',
  topics: [
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    '0x000000000000000000000000a3f4d738c97a6efb0ee936e3851c34d94b60aaac',
    '0x00000000000000000000000087a3effb84cbe1e4cab6ab430139ec41d156d55a',
  ],
  data: '0x0000000000000000000000000000000000000000000000000011c37937e08000',
  blockHash: '0x7878273aa8bd7677692d885b11440217808542eabcfe1c3811bd568d70de2212',
  blockNumber: '0xb5cd24',
  blockTimestamp: '0x6acfb174',
  transactionHash: '0x9d00804aee88a65af584223f2ad406465b78e66d19346a60c63561995d91cd12',
  logIndex: '0x5',
  removed: false,
};

describe('decodeTransferLog', () => {
  it('decodes a real Sepolia ETH transfer log', () => {
    expect(decodeTransferLog(sepoliaLog)).toEqual({
      from: '0xa3f4d738c97a6efb0ee936e3851c34d94b60aaac',
      to: '0x87a3effb84cbe1e4cab6ab430139ec41d156d55a',
      valueWei: 5_000_000_000_000_000n,
      txHash: '0x9d00804aee88a65af584223f2ad406465b78e66d19346a60c63561995d91cd12',
      blockNumber: 0xb5cd24,
      blockHash: '0x7878273aa8bd7677692d885b11440217808542eabcfe1c3811bd568d70de2212',
      logIndex: 5,
      timestamp: 0x6acfb174,
    });
  });

  it('ignores an ERC-20 Transfer emitted by a token contract', () => {
    expect(decodeTransferLog({ ...sepoliaLog, address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238' })).toBeNull();
  });

  it('ignores a system-address log with a different topic', () => {
    const approval = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
    expect(decodeTransferLog({ ...sepoliaLog, topics: [approval, ...sepoliaLog.topics.slice(1)] })).toBeNull();
  });
});

describe('weiToEth', () => {
  it('converts wei to ETH', () => {
    expect(weiToEth(5_000_000_000_000_000n)).toBe(0.005);
  });
});
