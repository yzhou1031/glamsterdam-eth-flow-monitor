import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/csv.js';
import { loadSanctions } from '../src/sanctions.js';
import { screen } from '../src/screen.js';

const dataDir = fileURLToPath(new URL('../data', import.meta.url));

describe('replay of the demo screening set', () => {
  it('flags all 15 Lazarus Group and Garantex addresses (100% recall)', () => {
    const [head, ...rows] = parseCsv(fs.readFileSync(`${dataDir}/demo_screening_set.csv`, 'utf8'));
    const col = head!.indexOf('eth_address');
    const addresses = rows.map((r) => r[col]!);
    expect(addresses).toHaveLength(15);
    const sanctions = loadSanctions(dataDir);
    const sender = '0x' + '1'.repeat(40);
    const flagged = addresses.filter((to) =>
      screen({ from: sender, to, valueWei: 1n }, sanctions, () => undefined).some((m) => m.reason === 'sanctions'),
    );
    expect(flagged).toHaveLength(15);
  });
});
