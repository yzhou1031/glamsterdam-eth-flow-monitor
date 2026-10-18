import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv, toCsv } from './csv.js';

export const OFAC_FILE = 'ofac_sdn_eth_addresses.csv';
export const MOCK_FILE = 'mock_sanctions.csv';
export const SDN_CSV_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV';

export interface SanctionEntry {
  address: string;
  name: string;
  program: string;
  source: 'ofac' | 'mock';
}

export interface SanctionsList {
  /** sha256 of both files (first 12 hex chars) + load date. Recorded on every alert for audit. */
  version: string;
  loadedAt: number;
  entries: Map<string, SanctionEntry>;
  ofacCount: number;
  mockCount: number;
  /** Date the OFAC addresses were downloaded (the file's "retrieved" column). */
  retrieved?: string;
}

const readIfExists = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

function rowsWithHeader(text: string): Record<string, string>[] {
  const [head, ...rest] = parseCsv(text);
  if (!head) return [];
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

export function loadSanctions(dataDir: string, nowMs = Date.now()): SanctionsList {
  const ofacText = readIfExists(path.join(dataDir, OFAC_FILE));
  const mockText = readIfExists(path.join(dataDir, MOCK_FILE));
  const entries = new Map<string, SanctionEntry>();
  let ofacCount = 0;
  let mockCount = 0;
  let retrieved: string | undefined;
  for (const r of rowsWithHeader(ofacText)) {
    if (!r.eth_address) continue;
    retrieved ??= r.retrieved || undefined;
    const address = r.eth_address.toLowerCase();
    entries.set(address, { address, name: r.name ?? '', program: r.program ?? '', source: 'ofac' });
    ofacCount++;
  }
  for (const r of rowsWithHeader(mockText)) {
    if (!r.address) continue;
    const address = r.address.toLowerCase();
    entries.set(address, { address, name: r.name ?? '', program: r.program ?? '', source: 'mock' });
    mockCount++;
  }
  const hash = crypto.createHash('sha256').update(ofacText).update('\n--mock--\n').update(mockText).digest('hex').slice(0, 12);
  return { version: `${hash}@${new Date(nowMs).toISOString().slice(0, 10)}`, loadedAt: nowMs, entries, ofacCount, mockCount, retrieved };
}

export interface SdnEthRow {
  sdn_entry_id: string;
  name: string;
  program: string;
  eth_address: string;
}

const ETH_RE = /Digital Currency Address - ETH\s+(0x[0-9a-fA-F]{40})/g;

/** SDN.CSV has no header; column 0 = entry id, 1 = name, 3 = program(s), 11 = remarks holding the crypto addresses. */
export function extractEthFromSdnCsv(text: string): SdnEthRow[] {
  const out: SdnEthRow[] = [];
  for (const r of parseCsv(text)) {
    if (r.length < 12) continue;
    for (const m of r[11]!.matchAll(ETH_RE)) {
      out.push({ sdn_entry_id: r[0]!, name: r[1]!, program: r[3]!.replace(/\] \[/g, '; '), eth_address: m[1]! });
    }
  }
  return out;
}

/** Downloads the SDN list and rewrites the OFAC file. Throws (leaving the old file in place) on any failure. */
export async function refreshFromOfac(dataDir: string, fetchFn: typeof fetch = fetch): Promise<number> {
  const res = await fetchFn(SDN_CSV_URL, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`OFAC download failed: HTTP ${res.status}`);
  const text = new TextDecoder('latin1').decode(await res.arrayBuffer());
  const rows = extractEthFromSdnCsv(text);
  if (rows.length === 0) throw new Error('OFAC download contained no ETH addresses');
  const day = new Date().toISOString().slice(0, 10);
  const csv = toCsv(
    ['sdn_entry_id', 'name', 'program', 'eth_address', 'source', 'retrieved'],
    rows.map((r) => [r.sdn_entry_id, r.name, r.program, r.eth_address, 'OFAC SDN.CSV', day]),
  );
  fs.writeFileSync(path.join(dataDir, OFAC_FILE), csv);
  return rows.length;
}

export function ofacFileAgeMs(dataDir: string, nowMs = Date.now()): number {
  const file = path.join(dataDir, OFAC_FILE);
  return fs.existsSync(file) ? nowMs - fs.statSync(file).mtimeMs : Infinity;
}
