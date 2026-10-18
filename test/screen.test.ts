import { describe, expect, it } from 'vitest';
import { screen, type WatchEntry } from '../src/screen.js';
import type { SanctionsList } from '../src/sanctions.js';

const A = '0x' + 'a'.repeat(40);
const BAD = '0x' + 'b'.repeat(40);
const W = '0x' + 'c'.repeat(40);
const sanctions: SanctionsList = {
  version: 'v1@2026-10-14', loadedAt: 0, ofacCount: 1, mockCount: 0,
  entries: new Map([[BAD, { address: BAD, name: 'LAZARUS GROUP', program: 'DPRK3', source: 'ofac' as const }]]),
};
const watch = new Map<string, WatchEntry>([[W, { address: W, label: 'Client treasury', minWei: 10n }]]);
const getWatch = (a: string) => watch.get(a);

describe('screen', () => {
  it('flags a transfer to a sanctioned address, whatever its letter case', () => {
    const m = screen({ from: A, to: BAD.toUpperCase().replace('0X', '0x'), valueWei: 1n }, sanctions, getWatch);
    expect(m).toEqual([{ reason: 'sanctions', matchedAddress: BAD, matchedEntry: 'LAZARUS GROUP (DPRK3; OFAC SDN)', listVersion: 'v1@2026-10-14' }]);
  });

  it('applies the watchlist minimum amount', () => {
    expect(screen({ from: W, to: A, valueWei: 5n }, sanctions, getWatch)).toEqual([]);
    expect(screen({ from: W, to: A, valueWei: 10n }, sanctions, getWatch)).toEqual([
      { reason: 'watchlist', matchedAddress: W, matchedEntry: 'Client treasury', listVersion: null },
    ]);
  });

  it('reports both a sanctions and a watchlist match on one transfer', () => {
    expect(screen({ from: BAD, to: W, valueWei: 20n }, sanctions, getWatch).map((m) => m.reason)).toEqual(['sanctions', 'watchlist']);
  });

  it('returns nothing for a clean transfer', () => {
    expect(screen({ from: A, to: '0x' + 'e'.repeat(40), valueWei: 1n }, sanctions, getWatch)).toEqual([]);
  });
});
