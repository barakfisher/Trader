/**
 * Portfolio import: parse, validate, resolve (FLOWS.md F1).
 *
 * Design rules:
 *  - A file is rejected as a whole only when it cannot be parsed at all. A bad
 *    row is reported with its line number and skipped - never silently dropped.
 *  - Symbols are resolved through the provider chain. An ambiguous symbol
 *    produces candidates for the user to pick; we never guess on their behalf.
 *  - Nothing is written to the database during preview.
 */

import { parse as parseCsv } from 'csv-parse/sync';
import { AiClient, type InstrumentResolution } from '@traders/shared/ai';
import { parseToMinor, type ImportRow, type ImportRowIssue, type ImportRowStatus, type Instrument } from '@traders/shared';

import { logger } from '../logger.js';

export class ImportParseError extends Error {}

/** Accepted header spellings, normalised to our field names. */
const HEADER_ALIASES: Record<string, string> = {
  symbol: 'symbol',
  ticker: 'symbol',
  instrument: 'symbol',
  asset: 'symbol',
  quantity: 'quantity',
  qty: 'quantity',
  shares: 'quantity',
  units: 'quantity',
  amount: 'quantity',
  cost_basis: 'cost_basis',
  costbasis: 'cost_basis',
  cost: 'cost_basis',
  price: 'cost_basis',
  avg_price: 'cost_basis',
  average_price: 'cost_basis',
  cost_per_unit: 'cost_basis',
  buy_price: 'cost_basis',
  currency: 'currency',
  ccy: 'currency',
  opened_at: 'opened_at',
  date: 'opened_at',
  purchase_date: 'opened_at',
  bought_at: 'opened_at',
  notes: 'notes',
  note: 'notes',
  comment: 'notes',
};

function normaliseKey(key: string): string | null {
  const cleaned = key.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z_]/g, '');
  return HEADER_ALIASES[cleaned] ?? null;
}

function normaliseRecord(record: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const mapped = normaliseKey(key);
    if (mapped && value !== null && value !== undefined && String(value).trim() !== '') {
      output[mapped] = String(value).trim();
    }
  }
  return output;
}

/** Split raw file content into normalised records, keeping original line numbers. */
export function parseFile(
  content: string,
  filename: string,
): { line: number; record: Record<string, string> }[] {
  const looksJson = filename.toLowerCase().endsWith('.json') || content.trimStart().startsWith('{') || content.trimStart().startsWith('[');

  if (looksJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new ImportParseError(`file is not valid JSON: ${(error as Error).message}`);
    }
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { holdings?: unknown }).holdings)
        ? ((parsed as { holdings: unknown[] }).holdings)
        : null;
    if (!list) {
      throw new ImportParseError('expected a JSON array of holdings or an object with a "holdings" array');
    }
    return list.map((item, index) => ({
      line: index + 1,
      record: normaliseRecord(item as Record<string, unknown>),
    }));
  }

  let records: Record<string, unknown>[];
  try {
    records = parseCsv(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    }) as Record<string, unknown>[];
  } catch (error) {
    throw new ImportParseError(`file is not valid CSV: ${(error as Error).message}`);
  }
  // +2: one for the header row, one because humans count from 1.
  return records.map((record, index) => ({ line: index + 2, record: normaliseRecord(record) }));
}

interface ValidatedRow {
  line: number;
  raw: Record<string, string>;
  symbol: string | null;
  quantity: string | null;
  costBasisMinor: number | null;
  currency: string;
  openedAt: string | null;
  notes: string | null;
  issues: ImportRowIssue[];
}

const QUANTITY_PATTERN = /^\d+(\.\d+)?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validateRow(
  entry: { line: number; record: Record<string, string> },
  defaultCurrency: string,
): ValidatedRow {
  const { line, record } = entry;
  const issues: ImportRowIssue[] = [];

  const symbolRaw = record.symbol ?? null;
  const symbol = symbolRaw ? symbolRaw.toUpperCase().replace(/\s+/g, '') : null;
  if (!symbol) issues.push({ field: 'symbol', message: 'symbol is required' });

  const currency = (record.currency ?? defaultCurrency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    issues.push({ field: 'currency', message: `"${currency}" is not a 3-letter currency code` });
  }

  let quantity: string | null = null;
  const quantityRaw = record.quantity?.replace(/,/g, '');
  if (!quantityRaw) {
    issues.push({ field: 'quantity', message: 'quantity is required' });
  } else if (!QUANTITY_PATTERN.test(quantityRaw)) {
    issues.push({ field: 'quantity', message: `"${record.quantity}" is not a positive number` });
  } else if (Number(quantityRaw) <= 0) {
    issues.push({ field: 'quantity', message: 'quantity must be greater than zero' });
  } else {
    quantity = quantityRaw;
  }

  let costBasisMinor: number | null = null;
  if (record.cost_basis) {
    const parsed = parseToMinor(record.cost_basis, currency);
    if (parsed === null || parsed < 0) {
      issues.push({
        field: 'cost_basis',
        message: `"${record.cost_basis}" is not a valid per-unit cost`,
      });
    } else {
      costBasisMinor = parsed;
    }
  }

  let openedAt: string | null = null;
  if (record.opened_at) {
    const candidate = record.opened_at.slice(0, 10);
    if (!DATE_PATTERN.test(candidate) || Number.isNaN(Date.parse(candidate))) {
      issues.push({ field: 'opened_at', message: `"${record.opened_at}" is not a YYYY-MM-DD date` });
    } else {
      openedAt = candidate;
    }
  }

  return {
    line,
    raw: record,
    symbol,
    quantity,
    costBasisMinor,
    currency,
    openedAt,
    notes: record.notes ?? null,
    issues,
  };
}

export interface BuildPreviewOptions {
  content: string;
  filename: string;
  defaultCurrency: string;
  ai: AiClient;
  requestId?: string;
  /** Told each symbol's resolution - how the route records universe gaps. */
  onResolution?: (symbol: string, resolution: InstrumentResolution) => Promise<void>;
}

export async function buildImportRows(options: BuildPreviewOptions): Promise<ImportRow[]> {
  const entries = parseFile(options.content, options.filename);
  if (entries.length === 0) throw new ImportParseError('file contains no data rows');

  const validated = entries.map((entry) => validateRow(entry, options.defaultCurrency));

  // Resolve each distinct symbol once, concurrently but bounded.
  const distinct = [...new Set(validated.map((row) => row.symbol).filter((s): s is string => !!s))];
  const resolutions = new Map<string, { resolved: Omit<Instrument, 'id'> | null; candidates: Omit<Instrument, 'id'>[] }>();
  const batchSize = 8;
  for (let index = 0; index < distinct.length; index += batchSize) {
    const batch = distinct.slice(index, index + batchSize);
    await Promise.all(
      batch.map(async (symbol) => {
        try {
          const result = await options.ai.resolveInstrument(symbol, options.requestId);
          await options.onResolution?.(symbol, result);
          resolutions.set(symbol, {
            resolved: result.resolved ? toInstrument(result.resolved) : null,
            candidates: (result.candidates ?? []).map(toInstrument),
          });
        } catch (error) {
          logger().warn({ symbol, err: error }, 'symbol resolution failed');
          resolutions.set(symbol, { resolved: null, candidates: [] });
        }
      }),
    );
  }

  const seenSymbols = new Set<string>();
  return validated.map((row) => {
    const resolution = row.symbol ? resolutions.get(row.symbol) : undefined;
    let status: ImportRowStatus;
    const issues = [...row.issues];

    if (issues.length > 0) {
      status = 'invalid';
    } else if (row.symbol && seenSymbols.has(row.symbol)) {
      status = 'duplicate';
      issues.push({
        field: 'symbol',
        message: 'this symbol appears earlier in the file; only the first row is imported',
      });
    } else if (resolution?.resolved) {
      status = 'ok';
      seenSymbols.add(row.symbol as string);
    } else if (resolution && resolution.candidates.length > 0) {
      status = 'ambiguous';
      issues.push({ field: 'symbol', message: 'pick the intended instrument' });
    } else {
      status = 'unresolved';
      issues.push({ field: 'symbol', message: 'no market data provider could price this symbol' });
    }

    return {
      line: row.line,
      raw: row.raw,
      status,
      symbol: row.symbol,
      resolvedInstrument: resolution?.resolved ?? null,
      candidates: resolution?.candidates ?? [],
      quantity: row.quantity,
      costBasisMinor: row.costBasisMinor,
      currency: row.currency,
      openedAt: row.openedAt,
      notes: row.notes,
      issues,
    };
  });
}

export function countByStatus(rows: ImportRow[]): Record<ImportRowStatus, number> {
  const counts: Record<ImportRowStatus, number> = {
    ok: 0,
    ambiguous: 0,
    unresolved: 0,
    invalid: 0,
    duplicate: 0,
  };
  rows.forEach((row) => {
    counts[row.status] += 1;
  });
  return counts;
}

function toInstrument(input: {
  symbol: string;
  name?: string | null;
  asset_class?: string;
  exchange?: string | null;
  currency?: string;
}): Omit<Instrument, 'id'> {
  return {
    symbol: input.symbol.toUpperCase(),
    name: input.name ?? null,
    assetClass: (input.asset_class as Instrument['assetClass']) ?? 'unknown',
    exchange: input.exchange ?? null,
    currency: (input.currency ?? 'USD').toUpperCase(),
  };
}
