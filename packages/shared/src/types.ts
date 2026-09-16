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

// --- Snapshots ---------------------------------------------------------------

/**
 * One stored day of the equity curve. Snapshots are historical facts: they are
 * written once and never recomputed, so each row carries how complete the
 * pricing was at the time. A consumer that charts or analyses the series must
 * treat a `degraded` point as approximate rather than as a real move.
 */
export interface PortfolioSnapshot {
  /** Calendar date in the user's timezone, ISO 8601 (YYYY-MM-DD). */
  asOf: string;
  totalMinor: number;
  costMinor: number;
  currency: string;
  /** Holdings held on `asOf`, priced or not. */
  holdingsCount: number;
  /** Of those, how many contributed to `totalMinor`; a lower number understates it. */
  pricedCount: number;
  /** True when any holding was unpriced or any quote was stale. */
  degraded: boolean;
}

export interface SnapshotsResponse {
  /** Oldest first, so the series can be charted as returned. */
  snapshots: PortfolioSnapshot[];
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

// --- Observations (PRD FR-8, FR-16) ------------------------------------------

/** The rules the analysis engine runs today. New kinds are added, never renamed. */
export type ObservationKind = 'price_move' | 'sigma_move' | 'drawdown' | 'allocation_drift';

/** Derived from the size of the statistic, never chosen by a narrator. */
export type ObservationSeverity = 'info' | 'notable' | 'high';

export type ObservationSubjectKind = 'instrument' | 'portfolio' | 'topic';

/**
 * One explained finding.
 *
 * `evidence` is the finding's own numbers, exactly as the rule recorded them,
 * and it is deliberately untyped: each kind records the figures its own
 * sentence might quote, and the set grows whenever a rule does. It is a bag of
 * keys by design, so consumers must read it defensively.
 *
 * Its keys carry their unit as a suffix, which is the only way a reader can
 * know what a number means: `*_minor` is integer minor units of the `currency`
 * (or `base_currency`) recorded alongside it, `*_pct` / `*_ratio` / `*_weight`
 * are fractions where 1 is 100%, and `as_of` / `*_as_of` are ISO 8601 UTC.
 *
 * `explanation` is the sentence shown to the user. Every figure in it comes
 * from `evidence` and is rejected by the evidence validator otherwise
 * (guideline 7), which is what makes the drawer below it a real check rather
 * than decoration.
 */
export interface Observation {
  id: string;
  kind: ObservationKind;
  severity: ObservationSeverity;
  subjectKind: ObservationSubjectKind;
  /** `instrument:NVDA`, `portfolio:allocation:AAPL` — a kind-prefixed handle. */
  subjectRef: string;
  headline: string;
  explanation: string;
  evidence: Record<string, unknown>;
  /** Slugs of the concepts the finding invoked, e.g. `daily-return`. */
  conceptRefs: string[];
  createdAt: string;
}

export interface ObservationsResponse {
  /** Newest first, as returned. */
  observations: Observation[];
}
