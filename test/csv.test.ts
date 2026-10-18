import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from '../src/csv.js';

describe('parseCsv', () => {
  it('handles quotes, embedded commas, escaped quotes and CRLF', () => {
    const text = 'a,b,c\r\n1,"x, y","say ""hi"""\r\n2,,last\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "hi"'],
      ['2', '', 'last'],
    ]);
  });

  it('returns no rows for empty text', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('toCsv', () => {
  it('round-trips through parseCsv', () => {
    const out = toCsv(['name', 'note'], [['LAZARUS GROUP', 'has, comma'], ['X', 'quote "q"']]);
    expect(parseCsv(out)).toEqual([['name', 'note'], ['LAZARUS GROUP', 'has, comma'], ['X', 'quote "q"']]);
  });
});
