import { describe, expect, it } from 'vitest';

import { ImportParseError, buildImportRows, countByStatus, parseFile } from '../src/services/importer.js';
import { createFakeAi } from './fakeAi.js';

const ai = createFakeAi();

async function rowsFrom(content: string, filename = 'portfolio.csv') {
  return buildImportRows({ content, filename, defaultCurrency: 'USD', ai });
}

describe('parseFile', () => {
  it('maps alternative header spellings onto our fields', () => {
    const entries = parseFile('Ticker,Shares,Avg Price\nAAPL,10,185.40\n', 'p.csv');
    expect(entries[0]!.record).toEqual({ symbol: 'AAPL', quantity: '10', cost_basis: '185.40' });
  });

  it('reports line numbers that match the file the user sees', () => {
    const entries = parseFile('symbol,quantity\nAAPL,1\nVOO,2\n', 'p.csv');
    expect(entries.map((entry) => entry.line)).toEqual([2, 3]);
  });

  it('accepts a bare JSON array and a { holdings: [...] } object', () => {
    expect(parseFile('[{"symbol":"AAPL","quantity":1}]', 'p.json')).toHaveLength(1);
    expect(parseFile('{"holdings":[{"symbol":"AAPL","quantity":1}]}', 'p.json')).toHaveLength(1);
  });

  it('rejects a file it cannot parse at all', () => {
    expect(() => parseFile('{not json', 'p.json')).toThrow(ImportParseError);
  });
});

describe('buildImportRows', () => {
  it('accepts a clean row', async () => {
    const rows = await rowsFrom('symbol,quantity,cost_basis\nAAPL,10,185.40\n');
    expect(rows[0]!.status).toBe('ok');
    expect(rows[0]!.costBasisMinor).toBe(18540);
    expect(rows[0]!.resolvedInstrument?.symbol).toBe('AAPL');
    expect(rows[0]!.issues).toEqual([]);
  });

  it('flags a bad quantity without discarding the row', async () => {
    const rows = await rowsFrom('symbol,quantity\nAAPL,abc\n');
    expect(rows[0]!.status).toBe('invalid');
    expect(rows[0]!.issues[0]!.field).toBe('quantity');
    expect(rows[0]!.line).toBe(2);
  });

  it('rejects a zero or negative quantity', async () => {
    const rows = await rowsFrom('symbol,quantity\nAAPL,0\nVOO,-3\n');
    expect(rows.map((row) => row.status)).toEqual(['invalid', 'invalid']);
  });

  it('requires a symbol', async () => {
    const rows = await rowsFrom('symbol,quantity\n,10\n');
    expect(rows[0]!.status).toBe('invalid');
    expect(rows[0]!.issues.some((issue) => issue.field === 'symbol')).toBe(true);
  });

  it('marks a symbol no provider can price as unresolved', async () => {
    const rows = await rowsFrom('symbol,quantity\nNOSUCH,10\n');
    expect(rows[0]!.status).toBe('unresolved');
    expect(rows[0]!.resolvedInstrument).toBeNull();
  });

  it('offers candidates instead of guessing an ambiguous symbol', async () => {
    const ambiguousAi = createFakeAi({ ambiguous: { SHELL: ['SHEL', 'SHEL.L'] } });
    const rows = await buildImportRows({
      content: 'symbol,quantity\nSHELL,10\n',
      filename: 'p.csv',
      defaultCurrency: 'USD',
      ai: ambiguousAi,
    });
    expect(rows[0]!.status).toBe('ambiguous');
    expect(rows[0]!.candidates.map((candidate) => candidate.symbol)).toEqual(['SHEL', 'SHEL.L']);
  });

  it('marks a repeated symbol as duplicate and keeps the first occurrence', async () => {
    const rows = await rowsFrom('symbol,quantity\nAAPL,10\nAAPL,5\n');
    expect(rows.map((row) => row.status)).toEqual(['ok', 'duplicate']);
  });

  it('defaults the currency and carries a per-row override', async () => {
    const rows = await rowsFrom('symbol,quantity,currency\nAAPL,1,\nVOO,1,eur\n');
    expect(rows[0]!.currency).toBe('USD');
    expect(rows[1]!.currency).toBe('EUR');
  });

  it('rejects a malformed date but keeps the rest of the row readable', async () => {
    const rows = await rowsFrom('symbol,quantity,opened_at\nAAPL,10,14/11/2023\n');
    expect(rows[0]!.status).toBe('invalid');
    expect(rows[0]!.issues[0]!.field).toBe('opened_at');
  });

  it('counts rows by status for the preview summary', async () => {
    const rows = await rowsFrom('symbol,quantity\nAAPL,10\nAAPL,1\nNOSUCH,2\n,5\n');
    expect(countByStatus(rows)).toEqual({ ok: 1, duplicate: 1, unresolved: 1, invalid: 1, ambiguous: 0 });
  });

  it('refuses an empty file', async () => {
    await expect(rowsFrom('symbol,quantity\n')).rejects.toThrow(ImportParseError);
  });

  it('imports the committed demo portfolio shape end to end', async () => {
    const rows = await rowsFrom(
      'symbol,quantity,cost_basis,currency,opened_at,notes\nAAPL,25,185.40,USD,2023-11-14,core holding\nBTC-USD,0.42,41250.00,USD,2024-01-30,\n',
    );
    expect(rows.every((row) => row.status === 'ok')).toBe(true);
    expect(rows[1]!.quantity).toBe('0.42');
    expect(rows[0]!.notes).toBe('core holding');
  });
});
