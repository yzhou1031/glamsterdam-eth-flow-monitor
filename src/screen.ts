import type { AlertReason } from './db.js';
import type { SanctionsList } from './sanctions.js';

export interface WatchEntry {
  address: string;
  label: string;
  minWei: bigint;
}

export interface Match {
  reason: AlertReason;
  matchedAddress: string;
  matchedEntry: string;
  listVersion: string | null;
}

export function screen(
  t: { from: string; to: string; valueWei: bigint },
  sanctions: SanctionsList,
  getWatch: (address: string) => WatchEntry | undefined,
): Match[] {
  const matches: Match[] = [];
  for (const side of new Set([t.from.toLowerCase(), t.to.toLowerCase()])) {
    const s = sanctions.entries.get(side);
    if (s) {
      const source = s.source === 'mock' ? 'mock list' : 'OFAC SDN';
      matches.push({ reason: 'sanctions', matchedAddress: side, matchedEntry: `${s.name} (${s.program}; ${source})`, listVersion: sanctions.version });
    }
    const w = getWatch(side);
    if (w && t.valueWei >= w.minWei) {
      matches.push({ reason: 'watchlist', matchedAddress: side, matchedEntry: w.label || side, listVersion: null });
    }
  }
  return matches;
}
