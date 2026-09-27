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

export interface ObservationsResponse {
  /** Newest first, as returned. */
  observations: Observation[];
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

/** One of the user's topics, without its instruments. */
export interface TopicSummary {
  id: string;
  /** The user's own words, trimmed. */
  label: string;
  status: TopicStatus;
  createdBy: 'user' | 'auto';
  createdAt: string;
  updatedAt: string;
  /** When the user last confirmed the instrument set; null for an unconfirmed proposal. */
  confirmedAt: string | null;
  instrumentCount: number;
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
export interface TopicArticle {
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
}

/** The bounds a topic write is held to, published so the UI can show them. */
export interface TopicLimits {
  maxActiveTopics: number;
  maxInstrumentsPerTopic: number;
  maxLabelLength: number;
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
