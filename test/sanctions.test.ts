import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractEthFromSdnCsv, loadSanctions, refreshFromOfac, MOCK_FILE, OFAC_FILE } from '../src/sanctions.js';

const sdnRow = [
  '27307', 'LAZARUS GROUP', '-0- ', 'DPRK3] [CYBER2', '-0- ', '-0- ', '-0- ', '-0- ', '-0- ', '-0- ', '-0- ',
  'Digital Currency Address - ETH 0x098B716B8Aaf21512996dC57EB0615e2383E2f96; Digital Currency Address - XBT bc1qexample; Digital Currency Address - ETH 0xa0e1c89Ef1a489c9C7dE96311eD5Ce5D32c20E4B.',
].map((c) => `"${c}"`).join(',');
const otherRow = ['1', 'SOMEONE', 'individual', 'SDGT', '', '', '', '', '', '', '', 'Passport 123'].map((c) => `"${c}"`).join(',');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'efm-sanctions-'));

describe('extractEthFromSdnCsv', () => {
  it('pulls every ETH address out of the remarks column', () => {
    expect(extractEthFromSdnCsv(`${sdnRow}\n${otherRow}\n`)).toEqual([
      { sdn_entry_id: '27307', name: 'LAZARUS GROUP', program: 'DPRK3; CYBER2', eth_address: '0x098B716B8Aaf21512996dC57EB0615e2383E2f96' },
      { sdn_entry_id: '27307', name: 'LAZARUS GROUP', program: 'DPRK3; CYBER2', eth_address: '0xa0e1c89Ef1a489c9C7dE96311eD5Ce5D32c20E4B' },
    ]);
  });
});

describe('loadSanctions', () => {
  it('merges OFAC and mock entries, lowercases addresses and versions the list', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, OFAC_FILE), 'sdn_entry_id,name,program,eth_address,source,retrieved\n27307,LAZARUS GROUP,DPRK3,0x098B716B8Aaf21512996dC57EB0615e2383E2f96,OFAC SDN.CSV,2026-10-14\n');
    fs.writeFileSync(path.join(dir, MOCK_FILE), 'address,name,program\n0x' + 'd'.repeat(40) + ',DEMO,DEMO\n');
    const list = loadSanctions(dir, Date.parse('2026-10-14T12:00:00Z'));
    expect(list.entries.size).toBe(2);
    expect(list.ofacCount).toBe(1);
    expect(list.mockCount).toBe(1);
    expect(list.entries.get('0x098b716b8aaf21512996dc57eb0615e2383e2f96')).toMatchObject({ name: 'LAZARUS GROUP', source: 'ofac' });
    expect(list.entries.get('0x' + 'd'.repeat(40))).toMatchObject({ source: 'mock' });
    expect(list.version).toMatch(/^[0-9a-f]{12}@2026-10-14$/);
  });

  it('returns an empty list when the files are missing', () => {
    expect(loadSanctions(tmp()).entries.size).toBe(0);
  });
});

describe('refreshFromOfac', () => {
  it('writes the extracted ETH addresses to the OFAC file', async () => {
    const dir = tmp();
    const fakeFetch = (async () => new Response(`${sdnRow}\n${otherRow}\n`)) as typeof fetch;
    expect(await refreshFromOfac(dir, fakeFetch)).toBe(2);
    expect(loadSanctions(dir).ofacCount).toBe(2);
  });

  it('keeps the previous file when the download fails', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, OFAC_FILE), 'old contents\n');
    const fakeFetch = (async () => new Response('', { status: 503 })) as typeof fetch;
    await expect(refreshFromOfac(dir, fakeFetch)).rejects.toThrow('HTTP 503');
    expect(fs.readFileSync(path.join(dir, OFAC_FILE), 'utf8')).toBe('old contents\n');
  });
});
