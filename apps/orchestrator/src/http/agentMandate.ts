/**
 * An agent's mandate on the wire (D165, D171-D173): what the agents API accepts,
 * how it is checked, and how a row reads back.
 *
 * The scan enforces it (`services/ai/app/agents/mandate.py`); this edge makes
 * sure what is stored is something that check can mean. In particular a
 * sector, industry or ETF category must be one `universe_taxonomy` holds now:
 * a misspelt "Technolgy" would otherwise restrict an agent to nothing, quietly,
 * scan after paid scan (D164).
 */

import { z } from 'zod';

import {
  HORIZONS,
  MARKET_CAPS,
  THESIS_STYLES,
  type AgentMandate,
  type Horizon,
  type MarketCap,
  type ThesisStyle,
} from '@traders/shared';

import { listTaxonomy, type AgentRow, type MandateColumns } from '../db/queries.js';
import { unprocessable } from './errors.js';

/** Basis points in one whole: 10000 bps = 100% of capital. */
export const BPS = 10_000;
/** As migration 0057's CHECKs have them. */
export const MAX_HOLDINGS_LIMIT = 100;
export const MAX_CLASSIFICATIONS = 200;
export const MAX_BLOCKED_SYMBOLS = 100;

/** A ticker as the universe spells them: BRK-B, BF.B, ^GSPC never trade but cost nothing to allow. */
const SYMBOL = /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/;

const names = z.array(z.string().trim().min(1).max(200)).max(MAX_CLASSIFICATIONS);

export const mandateSchema = z
  .object({
    riskLevel: z.number().int().min(1).max(10).nullable(),
    horizon: z.enum(HORIZONS).nullable(),
    thesisStyle: z.enum(THESIS_STYLES).nullable(),
    maxPositionBps: z.number().int().min(1).max(BPS).nullable(),
    cashBufferBps: z.number().int().min(0).max(BPS - 1).nullable(),
    maxHoldings: z.number().int().min(1).max(MAX_HOLDINGS_LIMIT).nullable(),
    allowEtfs: z.boolean(),
    marketCaps: z.array(z.enum(MARKET_CAPS)).max(MARKET_CAPS.length),
    sectors: names,
    industries: names,
    etfCategories: names,
    blockedSymbols: z
      .array(z.string().trim().toUpperCase().regex(SYMBOL, 'a ticker such as NVDA or BRK-B'))
      .max(MAX_BLOCKED_SYMBOLS),
  })
  .partial()
  .strict();

export type MandateInput = z.infer<typeof mandateSchema>;

/** The no-limit mandate every agent had before 0057, and a new one gets for fields left out. */
export const EMPTY_MANDATE: MandateColumns = {
  risk_level: null,
  horizon: null,
  thesis_style: null,
  max_position_bps: null,
  cash_buffer_bps: null,
  max_holdings: null,
  allow_etfs: true,
  market_caps: [],
  sectors: [],
  industries: [],
  etf_categories: [],
  blocked_symbols: [],
};

const unique = <T>(values: T[]): T[] => [...new Set(values)];

/** Input to columns: only the fields given, each deduplicated. */
export function toMandateColumns(input: MandateInput): Partial<MandateColumns> {
  const columns: Partial<MandateColumns> = {};
  if (input.riskLevel !== undefined) columns.risk_level = input.riskLevel;
  if (input.horizon !== undefined) columns.horizon = input.horizon;
  if (input.thesisStyle !== undefined) columns.thesis_style = input.thesisStyle;
  if (input.maxPositionBps !== undefined) columns.max_position_bps = input.maxPositionBps;
  if (input.cashBufferBps !== undefined) columns.cash_buffer_bps = input.cashBufferBps;
  if (input.maxHoldings !== undefined) columns.max_holdings = input.maxHoldings;
  if (input.allowEtfs !== undefined) columns.allow_etfs = input.allowEtfs;
  if (input.marketCaps !== undefined) columns.market_caps = unique(input.marketCaps);
  if (input.sectors !== undefined) columns.sectors = unique(input.sectors);
  if (input.industries !== undefined) columns.industries = unique(input.industries);
  if (input.etfCategories !== undefined) columns.etf_categories = unique(input.etfCategories);
  if (input.blockedSymbols !== undefined) columns.blocked_symbols = unique(input.blockedSymbols);
  return columns;
}

/**
 * Refuse classifications the universe does not hold. Only the names being
 * written are checked: a stored name a later rescreen retired stays until the
 * user changes that list, rather than failing an unrelated edit.
 */
export async function assertKnownClassifications(columns: Partial<MandateColumns>): Promise<void> {
  const asked = [columns.sectors, columns.industries, columns.etf_categories];
  if (asked.every((list) => list === undefined || list.length === 0)) return;
  const rows = await listTaxonomy();
  const sectors = new Set(rows.flatMap((row) => (row.sector === null ? [] : [row.sector])));
  const industries = new Set(rows.filter((row) => row.kind === 'industry').map((row) => row.name));
  const categories = new Set(rows.filter((row) => row.kind === 'etf_category').map((row) => row.name));
  const unknown = {
    sectors: (columns.sectors ?? []).filter((name) => !sectors.has(name)),
    industries: (columns.industries ?? []).filter((name) => !industries.has(name)),
    etfCategories: (columns.etf_categories ?? []).filter((name) => !categories.has(name)),
  };
  if (Object.values(unknown).some((list) => list.length > 0)) {
    throw unprocessable(
      'unknown_classification',
      'the universe holds no sector, industry or ETF category by these names',
      unknown,
    );
  }
}

/** The stored mandate as the wire reads it; null for the primary (D1). */
export function toMandateView(row: AgentRow): AgentMandate | null {
  if (row.is_primary) return null;
  return {
    riskLevel: row.risk_level,
    horizon: row.horizon as Horizon | null,
    thesisStyle: row.thesis_style as ThesisStyle | null,
    maxPositionBps: row.max_position_bps,
    cashBufferBps: row.cash_buffer_bps,
    maxHoldings: row.max_holdings,
    allowEtfs: row.allow_etfs,
    marketCaps: row.market_caps as MarketCap[],
    sectors: row.sectors,
    industries: row.industries,
    etfCategories: row.etf_categories,
    blockedSymbols: row.blocked_symbols,
  };
}
