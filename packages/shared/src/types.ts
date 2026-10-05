/**
 * The orchestrator <-> web contract.
 *
 * Wire format rules:
 *  - money: integer minor units in the field name suffixed `Minor`, always paired
 *    with a currency code somewhere in the same object;
 *  - decimal quantities: strings, so no precision is lost in JSON;
 *  - timestamps: ISO 8601 UTC strings.
 */

import type { LocalizedTexts, UiLanguage } from './language.js';

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

/**
 * An agent: the user's real portfolio (the primary, "Main portfolio") or a
 * simulated one with a paper budget (`docs/PROPOSAL-MULTI-AGENT.md`).
 *
 * `name` is the stored name; a client renders the primary through its own
 * catalogue instead, so the real portfolio is named in the reader's language.
 */
export type AgentState = 'active' | 'paused' | 'archived';

export interface AgentView {
  id: string;
  name: string;
  isPrimary: boolean;
  /** Free text the agent will decide by from Stage 4 (decision D20); stored now, read by nothing yet. */
  persona: string | null;
  /** The notional starting budget (decision D2), integer minor units. Null for the primary. */
  budgetMinor: number | null;
  /** Cash on hand (migration 0040), integer minor units. Null for the primary, which has none (D1). */
  cashMinor: number | null;
  currency: string;
  state: AgentState;
  holdingsCount: number;
  createdAt: string;
}

export interface AgentsResponse {
  agents: AgentView[];
}

export type TradeSide = 'buy' | 'sell';

/**
 * A trade the user places by hand into a simulated agent's account (D21).
 *
 * `quantity` is a whole number of shares as a decimal string (guideline 4, D9).
 * Without `price` the trade fills at the live quote; with it, at that typed
 * price, flagged. `shownPriceMinor` is the live price the preview showed, which
 * the fill must stay within D3's range of; `idempotencyKey` makes a repeated
 * submit one fill.
 */
export interface TradeInput {
  symbol: string;
  side: TradeSide;
  quantity: string;
  /** A typed price in dollars, at most two decimals - the override of D21. */
  price?: string;
  shownPriceMinor?: number;
  idempotencyKey?: string;
}

/** Something the user should see before confirming, which does not block the trade. */
export interface TradeWarning {
  kind: 'typed_price_far_from_quote';
  /** Signed distance of the typed price from the reference, in basis points. */
  deviationBps: number;
  referencePriceMinor: number;
  referenceAsOf: string;
}

/** What a trade would do, computed exactly as the fill would be. Nothing is written. */
export interface TradePreview {
  symbol: string;
  name: string | null;
  side: TradeSide;
  quantity: string;
  priceSource: 'quote' | 'user';
  priceMinor: number;
  /** When the quote was observed, and its provider delay; null for a typed price. */
  quoteAsOf: string | null;
  quoteDelaySeconds: number | null;
  notionalMinor: number;
  feeMinor: number;
  /** The signed change to cash: negative on a buy. */
  cashChangeMinor: number;
  cashMinor: number;
  cashAfterMinor: number;
  heldQuantity: string;
  heldAfterQuantity: string;
  currency: string;
  warnings: TradeWarning[];
}

/** One recorded trade, as the ledger holds it. */
export interface FillView {
  id: string;
  symbol: string;
  side: TradeSide;
  quantity: string;
  priceMinor: number;
  notionalMinor: number;
  feeMinor: number;
  currency: string;
  priceSource: 'quote' | 'user';
  quoteAsOf: string | null;
  quoteDelaySeconds: number | null;
  source: 'manual_user_override' | 'agent';
  createdAt: string;
}

/**
 * A simulated agent's account: cash, what it holds, and how it stands (D6).
 * `netWorthMinor` is cash plus market value; `pnlMinor` is net worth minus
 * every deposit. Both are null when any holding is unpriced - never a partial
 * figure that reads as complete (guideline 7).
 */
export interface AgentAccountResponse {
  currency: string;
  cashMinor: number;
  /** The opening deposit and every top-up: what the agent was given. Equals its budget. */
  depositsMinor: number;
  holdingsValueMinor: number | null;
  netWorthMinor: number | null;
  pnlMinor: number | null;
  pnlPct: number | null;
  portfolio: PortfolioResponse;
}

/** One movement of an agent's cash, with the balance it left (D31). */
export interface ActivityEntry {
  id: string;
  kind: 'opening_deposit' | 'top_up' | 'buy' | 'sell';
  /** Signed: a buy is negative, its fee included. */
  amountMinor: number;
  balanceAfterMinor: number;
  createdAt: string;
  /** The trade behind a buy or sell; null for a deposit. */
  fill: FillView | null;
}

export interface ActivityResponse {
  currency: string;
  entries: ActivityEntry[];
}

/** Add cash to an agent: `amount` in dollars, at most two decimals, like a budget. */
export interface TopUpInput {
  amount: string;
}

export interface TradeResult {
  fill: FillView;
  /** False when this idempotency key had already filled: the same fill, returned again. */
  created: boolean;
  cashMinor: number;
  heldQuantity: string;
}

export interface FillsResponse {
  fills: FillView[];
}

// --- Agent performance (Stage 3, PR 7; D24, D36-D42) ----------------------------

/**
 * One trading day's close: the agent's net worth and what the same deposits
 * would be worth in SPY. Either is null when a price that day is missing - an
 * unavailable figure, never a partial one (§5.4).
 */
export interface PerformancePoint {
  /** The session's date, New York (YYYY-MM-DD). */
  day: string;
  netWorthMinor: number | null;
  benchmarkMinor: number | null;
  /** Every deposit made before this close - what both lines were given. */
  depositsMinor: number;
}

/** The agent against the shadow SPY at the latest close (D24): both returns are P&L over deposits. */
export interface PerformanceComparison {
  day: string;
  depositsMinor: number;
  netWorthMinor: number | null;
  pnlMinor: number | null;
  returnPct: number | null;
  benchmarkMinor: number | null;
  benchmarkPnlMinor: number | null;
  benchmarkReturnPct: number | null;
  /** The agent's return minus SPY's, in percentage points. */
  differencePts: number | null;
}

/** The agent's own decisions over one rolling window (D39-D41). */
export interface ScoreWindow {
  days: number;
  /** Agent fills, buys and sells, inside the window. */
  decisions: number;
  /** Agent sells inside the window that sold shares the agent itself bought. */
  sells: number;
  /** Of those, the ones with a profit after fees. Break-even is not a win. */
  wins: number;
  winRatePct: number | null;
  realisedPnlMinor: number;
}

export interface AgentScore {
  /** Every fill the agent decided, ever. Zero until Stage 4: manual trades are never scored. */
  agentDecisions: number;
  windows: ScoreWindow[];
  /** What the agent's own book still holds, at the latest close; null when unpriced. */
  unrealisedPnlMinor: number | null;
}

export interface AgentPerformanceResponse {
  currency: string;
  benchmarkSymbol: string;
  series: PerformancePoint[];
  /** Null until the first close after the opening deposit. */
  comparison: PerformanceComparison | null;
  /** Deposits made after the latest close: in neither line until the next one. */
  pendingDepositsMinor: number;
  score: AgentScore;
}

/** A new simulated agent. `budget` is a decimal string, like every amount a user types. */
export interface AgentInput {
  name: string;
  budget: string;
  persona?: string | null;
}

export interface AgentPatchInput {
  name?: string;
  budget?: string;
  persona?: string | null;
  state?: AgentState;
}

export interface PortfolioResponse {
  summary: PortfolioSummary;
  holdings: HoldingView[];
  allocationByInstrument: AllocationSlice[];
  allocationByAssetClass: AllocationSlice[];
}

// --- Consolidated holdings (multi-agent Stage 3, PR 6) -------------------------

/**
 * One agent's holding of one instrument, inside a consolidated row. The real
 * portfolio's carries its holding id (it can be edited); a simulated agent's
 * changes only by a trade, on its own page (D35).
 */
export interface ConsolidatedPosition {
  agentId: string;
  /** The stored name; a client names the primary from its own catalogue. */
  agentName: string;
  isPrimary: boolean;
  state: AgentState;
  holdingId: string;
  quantity: string;
  /** Per unit, in `costCurrency`. */
  costBasisMinor: number | null;
  costCurrency: string;
  valueMinor: number | null;
  costMinor: number | null;
  pnlMinor: number | null;
  pnlPct: number | null;
}

/** What one side - real or simulated - holds of an instrument. Never summed with the other. */
export interface ConsolidatedSide {
  quantity: string;
  /** Null when the instrument is unpriced: a value is never invented (guideline 7). */
  valueMinor: number | null;
}

/** One instrument across the real portfolio and every non-archived agent (§4.3). */
export interface ConsolidatedRow {
  instrument: Instrument;
  quote: QuoteInfo | null;
  /** Null when the real portfolio does not hold it. */
  real: ConsolidatedSide | null;
  /** Every simulated agent's holding of it together; null when none holds it. */
  simulated: ConsolidatedSide | null;
  /** The real portfolio first, then the agents in the order the agents list shows them. */
  positions: ConsolidatedPosition[];
}

/**
 * A simulated agent's standing, as the account endpoint computes it (D6): net
 * worth and P&L are null when any of its holdings is unpriced (decision 111).
 */
export interface SimulatedAgentStanding {
  agentId: string;
  name: string;
  state: AgentState;
  currency: string;
  cashMinor: number;
  depositsMinor: number;
  holdingsValueMinor: number | null;
  netWorthMinor: number | null;
  pnlMinor: number | null;
  pnlPct: number | null;
  unpricedSymbols: string[];
}

/**
 * Every simulated agent together: one figure for paper money, shown beside the
 * real one and never added to it (§4.3, D34). Null when any agent's net worth
 * is - a total that left a position out would read as complete.
 */
export interface SimulatedTotals {
  agentCount: number;
  cashMinor: number;
  holdingsValueMinor: number | null;
  netWorthMinor: number | null;
  unpricedSymbols: string[];
}

export interface ConsolidatedHoldingsResponse {
  currency: string;
  /** The real portfolio's summary, exactly as `/portfolio` computes it. */
  real: PortfolioSummary;
  simulated: SimulatedTotals;
  /** Non-archived simulated agents; a paused one is here, badged (D18). */
  agents: SimulatedAgentStanding[];
  rows: ConsolidatedRow[];
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

// --- One holding -------------------------------------------------------------

/**
 * One day's close of an instrument, from stored prices only: the last real
 * observation of that UTC day - exactly the series the analysis rules read, so
 * a chart of it shows the prices a finding was computed from.
 */
export interface DailyClose {
  /** The UTC calendar day, YYYY-MM-DD. */
  day: string;
  priceMinor: number;
  currency: string;
  /** When the price that closed the day was observed, ISO 8601 UTC. */
  asOf: string;
}

export interface HoldingHistoryResponse {
  holdingId: string;
  symbol: string;
  /** How far back the series was asked for, in days. */
  days: number;
  /** Oldest first. A day with no stored price is absent, never filled. */
  closes: DailyClose[];
}

export interface HoldingNewsResponse {
  holdingId: string;
  symbol: string;
  /** The window the articles were published in, in days. */
  days: number;
  /** The newest articles in the window, at most a page of them. */
  articles: NewsArticle[];
  /** How many articles the window holds in all, so a page never reads as the whole week. */
  total: number;
  /** As on a topic card: which empty an empty list is. */
  collection: NewsCollectionState | null;
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

export type UserRole = 'user' | 'admin';

export interface SessionUser {
  id: string;
  baseCurrency: string;
  timezone: string;
  /** Display only: the server re-reads the role on every `/admin/*` request. */
  role: UserRole;
  /**
   * The interface language, from `user_settings`. Sent with the session so the
   * first screen after a sign-in or a reload is already in it - read from the
   * settings page instead, every page would draw in English first.
   */
  language: UiLanguage;
}

// --- Admin (M8) --------------------------------------------------------------

export interface AdminRun {
  id: string;
  /** Null for a run that belongs to the installation rather than to an account. */
  userId: string | null;
  kind: string;
  runKey: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface AdminRunsResponse {
  runs: AdminRun[];
}

/** One admin action, as recorded before it ran. The table is append-only. */
export interface AdminAuditEntry {
  id: string;
  adminUserId: string;
  /** `METHOD /path`, e.g. `POST /admin/universe/rescreen`. */
  action: string;
  detail: unknown;
  /** The address the nearest proxy saw, or null when there was none to trust. */
  ipAddress: string | null;
  requestId: string | null;
  occurredAt: string;
}

export interface AdminAuditResponse {
  entries: AdminAuditEntry[];
}

export type UniverseGapKind = 'universe_gap_missing_ticker' | 'universe_gap_low_confidence';

/**
 * One gap, counted. `detail` depends on `kind`: a missing ticker says the
 * symbol, where it was named and why the universe lacks it (`gap`:
 * `outside_screen` with the `rule`, `not_in_universe`, or `unpriced`); a
 * low-confidence topic says the topic, the best score and the gate.
 */
export interface UniverseGap {
  id: string;
  kind: UniverseGapKind;
  userId: string | null;
  detail: Record<string, unknown>;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /**
   * The listing's profile now, for a missing ticker: `on_demand` once it has
   * been described for the user who named it, `screened` once a rescreen has
   * admitted it (the gap is closed). Null when it has none - or for a topic.
   */
  profile: 'screened' | 'on_demand' | 'dropped' | null;
}

export interface UniverseGapsResponse {
  gaps: UniverseGap[];
}

/** One reason some of the snapshot's rows are not in the database, and how many. */
export interface UniverseDifference {
  reason: string;
  count: number;
}

/**
 * One count the snapshot and the database should agree on. `inSnapshot` is
 * what the last load read; `inDatabase` is what the database holds now.
 * `explained` are the loader's own reasons for the difference, and
 * `unexplained` is what is left - zero when every row is accounted for.
 */
export interface UniverseReconciliation {
  what: 'members' | 'etf_holdings';
  inSnapshot: number;
  inDatabase: number;
  explained: UniverseDifference[];
  unexplained: number;
}

export interface UniverseStatusResponse {
  /** Null until the loader has run since M8 PR 4: there is nothing to reconcile against. */
  lastLoad: {
    loadedAt: string;
    snapshotAsOf: string;
    source: string;
    /** The snapshot manifest's own counts, as the loader read them. */
    manifestCounts: Record<string, number>;
  } | null;
  database: {
    profiles: number;
    equities: number;
    etfs: number;
    embedded: number;
    etfHoldings: number;
    /** Profiles fetched for listings users named; not members, never compared with the snapshot. */
    onDemand: number;
    /** Former members a later snapshot no longer holds; kept, never searched. */
    dropped: number;
  };
  reconciliation: UniverseReconciliation[];
}

/**
 * The answer to "rescreen now" (decision 90). `running`: claimed and handed to
 * the AI service, which finishes the run - follow it in the runs list.
 * `skipped`: already claimed today, another rescreen still running, or this
 * installation cannot rescreen; `reason` says which.
 */
export type RescreenStartResponse =
  | { status: 'running'; runId: string; runKey: string }
  | { status: 'skipped'; runId: string | null; runKey: string; reason: string };

/** What happened on the wire when a model was asked (decision 87). */
export type LlmCallOutcome = 'ok' | 'provider_error' | 'budget_exhausted' | 'no_provider';

/**
 * The asking code's judgement of what came back. `not_judged` is a completion
 * nobody gave a verdict on - a call that returned nothing to judge, or a call
 * site that stopped between the call and its verdict.
 */
export type LlmCallVerdict =
  | 'accepted'
  | 'malformed'
  | 'unsourced_figures'
  | 'empty_completion'
  | 'degenerate_completion'
  | 'not_judged';

export interface LlmModelUsage {
  /** Null for a call refused before any model was chosen. */
  model: string | null;
  calls: number;
  /** OpenRouter's `:free` route: it bills nothing, so a zero cost is the price, not a gap. */
  free: boolean;
}

/** One agent's calls over the window. Money is integer micro-USD (guideline 3). */
export interface LlmAgentSummary {
  agent: string;
  calls: number;
  outcomes: Record<LlmCallOutcome, number>;
  verdicts: Record<LlmCallVerdict, number>;
  /** Over the calls that reached a provider; null when none did. */
  latency: { sample: number; p50Ms: number; p95Ms: number } | null;
  promptTokens: number;
  completionTokens: number;
  costMicroUsd: number;
  models: LlmModelUsage[];
}

/**
 * One reason a narration came out as it did, counted twice: once from the
 * explanations stored, once from the calls recorded. Narration makes exactly
 * one call per stored explanation, so the two should agree.
 */
export interface NarrationReconciliationRow {
  /** An `observations.fallback_reason`; `none` means the model wrote it. */
  reason: string;
  explanations: number;
  calls: number;
}

export interface LlmCallSummary {
  id: string;
  agent: string;
  model: string | null;
  outcome: LlmCallOutcome;
  /** Null when the call returned nothing to judge (any outcome but `ok`). */
  verdict: LlmCallVerdict | null;
  /** The provider's error, cut short; never the prompt or the completion. */
  error: string | null;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costMicroUsd: number;
  startedAt: string;
}

export interface LlmPanelResponse {
  window: { days: number; since: string };
  /** The oldest call still held (they are kept for a limited time); null when none is. */
  firstCallAt: string | null;
  agents: LlmAgentSummary[];
  /** Stored explanations over the whole window, by fallback reason - the longer record. */
  narrationFallbacks: { reason: string; count: number }[];
  /** From whichever is later, the window's start or the first recorded call; null with no calls. */
  reconciliation: { since: string; rows: NarrationReconciliationRow[] } | null;
  recent: LlmCallSummary[];
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
  /**
   * Who wrote `explanation`.
   *
   * Both kinds are equally trustworthy about their *figures* - the evidence
   * validator is what guarantees that, and it runs on the model's sentence
   * before it is ever stored. They are not equally informative about anything
   * else, and a reader deciding how much weight to give a sentence is entitled
   * to know which one they are reading.
   *
   * Null on observations written before this was recorded. That is "not
   * recorded", not "template": guessing would attribute authorship nobody
   * checked, and a UI must say the former rather than imply the latter.
   */
  narrationSource: NarrationSource | null;
  /** The template's wording in each translated language (`LocalizedTexts`). */
  localized: LocalizedTexts;
  /**
   * Why the model did not write it, when it did not.
   *
   * Free text rather than a union on purpose. It is diagnostic - a spent
   * budget, a refusing provider, figures the validator would not accept are
   * different problems with different fixes - and an unanticipated value here
   * must never be able to reject an observation that is otherwise fine.
   */
  fallbackReason: string | null;
  createdAt: string;
}

/** `template` is fixed phrasing over checked figures; `llm` is validated prose. */
export type NarrationSource = 'llm' | 'template';

/** Why a finding waited for the digest instead of being pushed. */
export type DigestReason = 'below_floor' | 'quiet_hours' | 'muted' | 'above_floor';

export interface DigestEntry {
  /** Null for a notice that explanations changed, which is not a finding. */
  observationId: string | null;
  headline: string | null;
  /** Empty for a notice, which is written in the interface's own catalogue. */
  localized: LocalizedTexts;
  severity: ObservationSeverity | null;
  subjectRef: string | null;
  reason: DigestReason;
  createdAt: string;
}

/**
 * The daily digest as the web app shows it (FR-13): what the next one will
 * carry, and what the last one delivered. Its findings are all in the feed too;
 * what only this says is which were held back from an interruption, and why.
 */
export interface DigestResponse {
  next: { entries: DigestEntry[] };
  /** Null until a digest has been delivered. */
  last: { sentAt: string; entries: DigestEntry[] } | null;
}

export interface ObservationsResponse {
  /** Newest first, and within one scan the most severe first, as returned. */
  observations: Observation[];
  /** How many findings the filter matches in all, so a page can say it is one. */
  total: number;
  /** The id to pass as `before` for the next page; null when there is none. */
  nextCursor: string | null;
}

// --- Per-user settings (migration 0006) --------------------------------------

/**
 * The knobs that decide what reaches the user, and when.
 *
 * Deliberately not the analysis thresholds: those describe how the engine reads
 * a market and belong to whoever operates it, while these describe one person's
 * attention and belong to them. The wire shape is the whole object because
 * `PUT /settings` replaces it whole - see the route for why a patch would let a
 * half-written quiet-hours window exist.
 */
export interface UserSettings {
  /** The floor at which a finding becomes a question to answer, not just news. */
  proposalSeverity: ObservationSeverity;
  /** How long a proposal stays answerable, in hours. */
  proposalTtlHours: number;
  /** The floor for an immediate push. Separate from `proposalSeverity` on purpose. */
  notifySeverity: ObservationSeverity;
  /**
   * A recurring local-time window, `HH:MM`, during which nothing is pushed.
   * Both ends are set or both are null: half a window has no defensible reading.
   * Read in the user's own timezone, and a window that wraps midnight is normal.
   */
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  /** A one-off silence, ISO 8601 UTC, or null when notifications are live. */
  mutedUntil: string | null;
  /** The language the web interface is shown in (migration 0034). */
  language: UiLanguage;
}

export interface UserSettingsResponse {
  settings: UserSettings;
}

// --- Proposals (migration 0006) ----------------------------------------------

/** The states a proposal can be in. Mirrors the CHECK in migration 0006. */
export type ProposalState = 'pending' | 'approved' | 'rejected' | 'snoozed' | 'expired';

/**
 * What a user can ask for. Deliberately not the same set as the states.
 * `undo` withdraws an approval: back to pending, its ledger row marked revoked.
 */
export type ProposalAction = 'approve' | 'reject' | 'snooze' | 'undo';

/** Where a decision came in. 'system' is the expiry sweep, not a person. */
export type DecisionSurface = 'web' | 'telegram' | 'system';

/**
 * An open question raised from a finding.
 *
 * `state` is **computed**: it accounts for a deadline that has passed and a
 * snooze that has elapsed since the row was last written. `storedState` is what
 * the database holds. They differ for real, and only briefly - between a
 * deadline passing and the sweep noticing - and a client that renders
 * `storedState` would offer a live Approve button on a dead question. Render
 * `state`; `storedState` is here for a debugging session, not for the UI.
 */
export interface Proposal {
  id: string;
  observationId: string;
  /** The action being assented to, in the shape the ledger records it. */
  kind: string;
  payload: unknown;
  state: ProposalState;
  storedState: ProposalState;
  severity: ObservationSeverity;
  subjectRef: string | null;
  headline: string;
  explanation: string | null;
  localized: LocalizedTexts;
  /** The figures behind the headline. Every number in the text appears here. */
  evidence: unknown;
  expiresAt: string;
  snoozedUntil: string | null;
  decidedAt: string | null;
  /** Until when Undo is accepted, for an approval still inside its window. */
  undoableUntil: string | null;
  decidedVia: DecisionSurface | null;
  createdAt: string;
}

export interface ProposalsResponse {
  proposals: Proposal[];
}

/** One immutable entry in a proposal's audit trail. */
export interface ProposalTransition {
  from: ProposalState;
  to: ProposalState;
  surface: DecisionSurface;
  /** False when the clock did this rather than a person. */
  byUser: boolean;
  at: string;
}

export interface ProposalDetailResponse {
  proposal: Proposal;
  /** Newest first. Explains a state the user never set themselves. */
  transitions: ProposalTransition[];
}

/**
 * The answer to a decision.
 *
 * `unchanged` is a success, not an error: it means the proposal was already in
 * the state asked for, which is what a second tap on the same button produces -
 * usually because the first reply was lost, and that user did nothing wrong.
 */
export interface DecisionResponse {
  outcome: 'applied' | 'unchanged';
  state: ProposalState;
  /** The ledger row an approval wrote. Null for every other outcome. */
  intentId: string | null;
}

// --- Target weights (migration 0001; `PUT /targets`) --------------------------

/**
 * One instrument's intended share of the portfolio.
 *
 * `weight` is a decimal string in the same units the database holds -
 * `numeric(6, 4)`, so `'0.2500'` is a quarter of the portfolio - and it stays a
 * string for the same reason a quantity does: a float on the wire would round
 * the number the user typed, and this is a number they will later compare
 * against the drift reported back to them.
 *
 * A weight of `'0.0000'` is a real target and not the absence of one. "I mean to
 * hold none of this" produces drift equal to whatever is still held; no target
 * at all produces no finding ever. Nothing in this contract may collapse the
 * two.
 */
export interface TargetWeight {
  symbol: string;
  /** The instrument's name, when one is known. Present on reads only. */
  name: string | null;
  weight: string;
}

export interface TargetsResponse {
  targets: TargetWeight[];
}

/** The whole set, written at once: `PUT /targets` replaces rather than merges. */
export interface TargetsUpdateRequest {
  targets: { symbol: string; weight: string }[];
}

export interface TargetsUpdateResponse {
  targets: { symbol: string; weight: string }[];
  /** Rows stored. Lower than `targets.length` only if a symbol was dropped. */
  count: number;
  /**
   * What the set adds up to, as a decimal string. Reported, never assumed: a
   * set may legitimately cover three of eight holdings, and no weight is
   * renormalised against this.
   */
  sum: string;
}

// --- Narration health (M4 debt; GET /narration) -------------------------------

/**
 * Whether explanations are being written by a model, and if not, why not.
 *
 * The states are distinct because their remedies are. A spent budget is fixed
 * by paying, a refusing provider by waiting or leaving a shared pool, and
 * sentences the evidence validator refuses only by a more capable model - no
 * amount of waiting or paying for the same one will help. A single "degraded"
 * would send a reader to the wrong answer, and "exhausted" would be wrong
 * outright for a free tier that answers every request and still narrates
 * nothing.
 */
export type NarrationState =
  /** No provider was asked for. A configuration, not a failure. */
  | 'off'
  /** The model is writing the explanations. */
  | 'narrating'
  /** The provider refused. A shared free pool, or an outage. */
  | 'unavailable'
  /** The spend ceiling stopped the calls. */
  | 'exhausted'
  /** The model answers and the evidence validator refuses its figures. */
  | 'rejected'
  /** Nothing recorded yet, or the AI service could not be reached. */
  | 'unknown';

/** `free` bills nothing and shares a pool; `paid` bills per token. */
export type NarrationTier = 'free' | 'paid' | 'none';

export interface NarrationHealthResponse {
  state: NarrationState;
  tier: NarrationTier;
  model: string | null;
  /** Explanations the state was read from. Zero means nothing is claimed. */
  sampleSize: number;
  /** The raw reason, for an operator rather than a reader. */
  lastFallbackReason: string | null;
}

// --- Concept corpus (M3; GET /concepts/:slug) ---------------------------------

/**
 * One `##` section of a concept explainer, as the ingester chunked it.
 *
 * `id` is the stored chunk id and is stable across re-ingestion of an unchanged
 * document, which is what makes it citable. `ord` is its position, so the
 * sections render in the order they were written rather than in whatever order
 * a query returned them.
 */
export interface ConceptSection {
  id: string;
  ord: number;
  heading: string | null;
  text: string;
}

/**
 * A concept explainer, whole.
 *
 * Delivered entire rather than as a ranked retrieval result: a chip names one
 * concept exactly, so there is nothing to score. `license` and `source` travel
 * with it because the corpus is required to be licence-clean, and a reader is
 * entitled to know who wrote the explanation they are being shown.
 */
export interface ConceptDocument {
  slug: string;
  title: string;
  source: string;
  uri: string | null;
  license: string;
  sections: ConceptSection[];
}

// --- Telegram binding (M4; GET /telegram/binding) -----------------------------

export interface TelegramBindingResponse {
  connected: boolean;
  /** Display only. A username is changeable by its owner, so nothing authorises off it. */
  username: string | null;
  boundAt: string | null;
}

/**
 * A freshly minted connect link.
 *
 * The URL is a bearer credential for one act: whoever opens it in Telegram
 * binds *their* chat to this account. It is single-use and short-lived, and it
 * is never to be shared - which the UI has to say out loud, because a `t.me`
 * link looks like an ordinary link.
 */
export interface TelegramConnectLink {
  url: string;
  expiresAt: string;
}

// --- Topics (M5; /topics) -----------------------------------------------------

export type TopicStatus = 'active' | 'proposed';

/**
 * How strong the resolver's match was when auto-discovery proposed a topic.
 * `weak` proposals are shown only when the user asks for them, and never take
 * a confident proposal's place (migration 0024).
 */
export type ProposalBand = 'confident' | 'weak';

/** One of the user's topics, without its instruments. */
export interface TopicSummary {
  id: string;
  /** The user's own words, trimmed. */
  label: string;
  status: TopicStatus;
  createdBy: 'user' | 'auto';
  /** Set on every auto-proposal, kept after it is accepted; null for a topic the user created. */
  proposalBand: ProposalBand | null;
  createdAt: string;
  updatedAt: string;
  /** When the user last confirmed the instrument set; null for an unconfirmed proposal. */
  confirmedAt: string | null;
  instrumentCount: number;
  /**
   * Why auto-discovery proposed it (FR-11); null for a topic the user created.
   * Kept after the proposal is accepted, so the card can still say where it came from.
   */
  evidence: TopicEvidence | null;
}

/**
 * The reason behind an auto-proposal. Every value is copied from stored data -
 * the phrase and headlines verbatim, the symbols from the resolver's candidates
 * (the confident ones for a confident proposal, every one offered for a weak
 * one) - so a proposal never says anything the news did not.
 */
export interface TopicEvidence {
  /** The phrase as the headlines spelled it most often. */
  phrase: string;
  /** Distinct articles, and distinct outlets, it appeared in within the window. */
  articleCount: number;
  sourceCount: number;
  windowDays: number;
  /** Up to five of those headlines, verbatim. */
  headlines: { articleId: string; title: string; source: string; publishedAt: string | null }[];
  /** What the resolver suggested when it was proposed, per `proposalBand`. Not a confirmed set. */
  symbols: string[];
}

/**
 * One confirmed instrument, and why it is in the topic.
 *
 * `source: 'resolver'` means the user ticked a suggestion. It carries the band,
 * a sentence quoted verbatim from the instrument's own description, and the
 * source ETFs that held it, all as they were when the user confirmed. `'user'`
 * means the user added a ticker the resolver missed. It carries no reasons,
 * because it was not suggested for any.
 */
export interface TopicInstrument {
  instrumentId: string;
  symbol: string;
  name: string | null;
  assetClass: AssetClass;
  source: 'resolver' | 'user';
  confidence: 'confident' | 'weak' | null;
  rationale: string | null;
  /** Weights are fractions of the fund as decimal strings: '0.2195' is 21.95%. */
  heldBy: { etf: string; weight: string }[];
  addedAt: string;
}

export interface TopicDetail extends TopicSummary {
  instruments: TopicInstrument[];
}

/**
 * One article about a topic, with the reason it is about the topic.
 *
 * An article reaches a topic only through an instrument the user confirmed for
 * it: `instruments` says which, and each carries the rule that linked it and the
 * exact text that matched, because a link is evidence and evidence without its
 * provenance cannot be checked.
 */
export type TopicArticle = NewsArticle;

/**
 * An article linked to an instrument, with the rule that linked it. Shared by a
 * topic's news and a holding's: both are "articles about these instruments".
 */
export interface NewsArticle {
  id: string;
  url: string;
  source: string;
  title: string;
  /** Null when the publisher gave none. Never invented. */
  publishedAt: string | null;
  fetchedAt: string;
  instruments: { symbol: string; matchMethod: string; matchedText: string | null; salience: string }[];
  /** The lexicon model's opinion, -1..1 as a decimal string; null when unscored. */
  sentiment: { score: string; magnitude: string; model: string } | null;
}

export interface TopicNewsResponse {
  topicId: string;
  /** The window the articles were published in, in days. */
  days: number;
  articles: TopicArticle[];
  /**
   * The latest finished news collection, so an empty `articles` can say which
   * empty it is: a quiet week (`ok`) or news the app could not get (`degraded`,
   * `failed`). Null when news has never been collected.
   */
  collection: NewsCollectionState | null;
}

export interface NewsCollectionState {
  lastRunAt: string;
  status: 'ok' | 'degraded' | 'failed' | 'skipped';
  /** Providers that refused or errored in that run, by name ("gdelt"). */
  failedProviders: string[];
}

/** Why a topic's sentiment score is null. Never a zero standing in for "unknown". */
export type TopicSentimentGap = 'no_articles' | 'not_scored' | 'too_few_polarised';

/** One article's contribution to a topic's sentiment. Ratios are decimal strings. */
export interface TopicSentimentArticle {
  id: string;
  url: string;
  source: string;
  title: string;
  publishedAt: string | null;
  score: string;
  magnitude: string;
  /** This article's share of the total weight, 0..1: how much of the score it is. */
  weight: string;
}

export interface TopicSentimentDay {
  /** `YYYY-MM-DD` in the user's timezone. */
  day: string;
  articles: number;
  /** Null on a day with no polarised article: an unmeasured day, not a neutral one. */
  score: string | null;
}

/**
 * A topic's tone over a rolling window (FR-12), with the articles behind it.
 *
 * `score` is the magnitude-weighted mean of the articles' scores, in -1..1, from
 * one model only: scores from different models are not comparable, so they are
 * never averaged together. Articles scored only by another model are counted in
 * `otherModels`, not mixed in.
 */
export interface TopicSentimentResponse {
  topicId: string;
  days: number;
  model: string | null;
  otherModels: string[];
  score: string | null;
  gap: TopicSentimentGap | null;
  /** `unscored` is articles `model` has not read; the three tones cover the rest. */
  counts: { articles: number; unscored: number; positive: number; negative: number; neutral: number };
  daily: TopicSentimentDay[];
  /** Articles with any weight, heaviest first, capped; `counts` covers them all. */
  behind: TopicSentimentArticle[];
}

/** The bounds a topic write is held to, published so the UI can show them. */
export interface TopicLimits {
  maxActiveTopics: number;
  maxInstrumentsPerTopic: number;
  maxLabelLength: number;
  /** Confident auto-proposals that may be open at once. */
  maxOpenProposals: number;
  /** Weak auto-proposals that may be open at once: a cap of their own. */
  maxOpenWeakProposals: number;
  /** Days a declined proposal's theme is not proposed again. */
  rejectionCooldownDays: number;
  /** Days a proposal waits for an answer before it expires and frees its slot. */
  proposalTtlDays: number;
}

export interface TopicsResponse {
  topics: TopicSummary[];
  limits: TopicLimits;
}

/**
 * Confirm a topic: its label and the exact instrument set the user chose.
 *
 * `symbols` mixes ticked suggestions and added tickers, and the server tells
 * them apart itself. It resolves the label again and records a symbol as
 * `resolver` only if the resolver offers it. Provenance is never taken from
 * the request, because a rationale is a quotation and the browser must not be
 * able to write one.
 */
export interface TopicConfirmRequest {
  label: string;
  symbols: string[];
}
