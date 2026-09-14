/**
 * The orchestrator <-> web contract.
 *
 * Wire format rules:
 *  - money: integer minor units in the field name suffixed `Minor`, always paired
 *    with a currency code somewhere in the same object;
 *  - decimal quantities: strings, so no precision is lost in JSON;
 *  - timestamps: ISO 8601 UTC strings.
 */

export type AssetClass = 'equity' | 'etf' | 'crypto' | 'fx' | 'index' | 'unknown';

export interface Instrument {
  id: string;
  symbol: string;
  name: string | null;
  assetClass: AssetClass;
  exchange: string | null;
  currency: string;
}

export interface QuoteInfo {
  priceMinor: number;
  currency: string;
  asOf: string;
  source: string;
  delaySeconds: number;
  dayChangePct: number | null;
  stale: boolean;
}

/** A holding with valuation applied, in the user's base currency. */
export interface HoldingView {
  id: string;
  instrument: Instrument;
  quantity: string;
  costBasisMinor: number | null;
  costCurrency: string;
  openedAt: string | null;
  notes: string | null;
  quote: QuoteInfo | null;
  /** Null when no provider could price the instrument. */
  valueMinor: number | null;
  costMinor: number | null;
  pnlMinor: number | null;
  pnlPct: number | null;
  weightPct: number | null;
  fxRate: string | null;
}

export interface AllocationSlice {
  key: string;
  label: string;
  valueMinor: number;
  weightPct: number;
}

export interface PortfolioSummary {
  baseCurrency: string;
  totalValueMinor: number;
  totalCostMinor: number;
  pnlMinor: number;
  pnlPct: number | null;
  dayChangeMinor: number | null;
  dayChangePct: number | null;
  holdingsCount: number;
  pricedCount: number;
  /** Symbols no provider could price; surfaced in the UI, never silently dropped. */
  unpricedSymbols: string[];
  /** True when any quote was served stale or any symbol is unpriced. */
  degraded: boolean;
  asOf: string;
}

export interface PortfolioResponse {
  summary: PortfolioSummary;
  holdings: HoldingView[];
  allocationByInstrument: AllocationSlice[];
  allocationByAssetClass: AllocationSlice[];
}

// --- Import (FLOWS.md F1) ----------------------------------------------------

export type ImportRowStatus = 'ok' | 'ambiguous' | 'unresolved' | 'invalid' | 'duplicate';

export interface ImportRowIssue {
  field: string;
  message: string;
}

export interface ImportRow {
  /** 1-based row number in the uploaded file, so errors point at something real. */
  line: number;
  raw: Record<string, string>;
  status: ImportRowStatus;
  symbol: string | null;
  resolvedInstrument: Omit<Instrument, 'id'> | null;
  candidates: Omit<Instrument, 'id'>[];
  quantity: string | null;
  costBasisMinor: number | null;
  currency: string;
  openedAt: string | null;
  notes: string | null;
  issues: ImportRowIssue[];
}

export interface ImportPreview {
  /** Opaque token identifying this parsed-but-not-committed upload. */
  previewId: string;
  filename: string;
  rows: ImportRow[];
  counts: Record<ImportRowStatus, number>;
  expiresAt: string;
}

export type ImportMode = 'merge' | 'replace';

export interface ImportCommitRequest {
  previewId: string;
  mode: ImportMode;
  /** Rows to import, by `line`. Omitted rows are skipped. */
  lines: number[];
  /** Chosen symbol per line, for rows the user disambiguated. */
  symbolOverrides?: Record<number, string>;
}

export interface ImportCommitResult {
  created: number;
  updated: number;
  skipped: number;
  failed: { line: number; message: string }[];
}

// --- Holdings CRUD -----------------------------------------------------------

export interface HoldingInput {
  symbol: string;
  quantity: string;
  costBasis?: string | null;
  currency?: string;
  openedAt?: string | null;
  notes?: string | null;
}

// --- Auth --------------------------------------------------------------------

export interface SessionUser {
  id: string;
  baseCurrency: string;
  timezone: string;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
  requestId?: string;
}
