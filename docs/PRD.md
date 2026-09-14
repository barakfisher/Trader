# PRD — AI Financial Advisor & Portfolio Copilot

**Status:** Draft v0.1 · **Owner:** barakfisher · **Last updated:** 2026-09-14

---

## 1. Problem

A retail investor holding a mixed portfolio (stocks, ETFs, crypto) has no cheap way to
(a) know *why* something in their portfolio moved, (b) keep a coherent watch on open-ended
themes they care about ("nuclear energy", "AI infrastructure"), and (c) learn the vocabulary
of the answer while getting it. Existing tools either dump raw data (brokers, screeners) or
give opaque signals with no explanation and no audit trail.

## 2. Product

A single-tenant-first B2C system that continuously watches the user's holdings and their
declared interest topics, and surfaces **explained observations** — never bare signals.
Anything that would change the portfolio is a *proposal* that requires an explicit human
approval, recorded with the evidence that produced it.

## 3. Non-negotiable product stances

These shape the whole architecture, so they are stated as requirements, not opinions.

| # | Stance |
|---|--------|
| P1 | **No order execution.** The system never places a trade. An approved proposal writes an intent + optional paper-trade fill to our own ledger. Broker integration is explicitly out of scope for v1. |
| P2 | **Educational framing, not advice.** Output is framed as observation + explanation + "what to read up on". No personalized advice, no price targets, no position sizing recommendations. A persistent disclaimer is shown in UI and appended to every Telegram digest. |
| P3 | **Every claim is sourced.** Each observation carries the data points and article URLs that produced it. If the engine can't cite, it doesn't emit. |
| P4 | **Approvals expire.** A proposal has a TTL (default 60 min). Markets move; a stale approval must be re-derived, not honoured. |
| P5 | **Quiet by default.** Cost and attention are budgets. Dedupe, rate-limit and quiet-hours are v1 features, not v2 polish. |

## 4. Users

- **Primary:** the owner-operator (single user, self-hosted). Data model is multi-tenant from
  day 1 (`user_id` on every row) but v1 ships one account.
- **Secondary (future):** invited users, each with own portfolio, topics and Telegram chat.

## 5. Functional requirements

### 5.1 Portfolio
- FR-1 Import holdings via CSV/JSON upload (symbol, quantity, cost basis, currency, opened_at) with a preview-and-confirm step and per-row validation errors.
- FR-2 Manual CRUD on holdings in the UI.
- FR-3 Asset classes: equity, ETF, crypto. Each holding resolves to a canonical instrument record.
- FR-4 Valuation: current value, absolute/% P&L per holding and per portfolio, in a single base currency (FX-converted). Quotes may be delayed; the delay is displayed.
- FR-5 Snapshot history: a daily portfolio snapshot enables the equity curve and drift detection.

### 5.2 Scheduled analysis
- FR-6 A scheduled run (default: intraday every 30 min during market hours + one daily close run) evaluates, per holding: price move vs configurable thresholds (1d/5d/σ-based), volume anomaly, drawdown from local high, and allocation drift vs target weights.
- FR-7 News ingestion per held symbol and per topic; dedupe by URL + content hash.
- FR-8 Each finding becomes an `Observation` with severity, evidence, and a plain-language explanation.
- FR-9 Runs are idempotent: the same input state must not produce duplicate observations or duplicate notifications.

### 5.3 Market discovery
- FR-10 User-defined topics as free text; the system resolves each to a candidate instrument set (tickers/ETFs) with a confidence score, shown for user confirmation.
- FR-11 Auto-discovery proposes new topics from recurring entities/themes in ingested news; proposals are accepted/rejected by the user and never auto-subscribed.
- FR-12 Per-topic sentiment over a rolling window, with the articles behind the score.
- FR-13 Daily digest: portfolio summary + top observations + topic movements, to UI and Telegram.

### 5.4 RAG / educational engine
- FR-14 A curated corpus of financial concepts and terminology is indexed (definitions, how a metric is computed, how to read it, common misreadings).
- FR-15 Natural-language Q&A over portfolio + corpus ("why is my NVDA position down?", "what is a P/E ratio?"), answering from retrieved context with citations, and declining when context is insufficient.
- FR-16 Every observation links the concepts it invoked (RSI, drawdown, earnings surprise…) so any term is one click from an explanation.

### 5.5 Human-in-the-loop
- FR-17 Proposal kinds: `watch`, `rebalance`, `trim`, `add`, `topic_subscribe`. Each has approve / reject / snooze.
- FR-18 Approval is possible from the UI or a Telegram inline button; both hit the same state machine and are idempotent (double-tap is a no-op).
- FR-19 Full audit trail: who/what/when/from which surface/on which evidence, immutable.

### 5.6 Telegram
- FR-20 One-time account binding via a signed deep link; unbound chats are ignored.
- FR-21 Alerts, daily digest, inline approve/reject, deep link into the relevant UI screen.
- FR-22 Callback payloads are signed, single-use and TTL-bounded; the webhook validates Telegram's secret token.

## 6. Non-functional requirements
- NFR-1 A scheduled run for a 50-holding portfolio completes in < 90 s.
- NFR-2 LLM/API spend cap per day, enforced in code; on breach, degrade to rule-based observations without LLM narration and log it.
- NFR-3 Market-data and news providers sit behind interfaces with per-provider rate limiting, caching and a documented fallback order.
- NFR-4 Traces for every run and every LLM call (LangSmith), request-id propagated Mastra → Python.
- NFR-5 Secrets only via env/K8s Secrets; no secret ever reaches the browser or a log line.
- NFR-6 Local `docker compose up` brings the whole system up with seeded demo data and no paid API key required (fixture provider).

## 7. Out of scope for v1
Order execution / broker APIs · tax-lot accounting and tax reporting · options, futures, bonds ·
backtesting engine · multi-user invitations and billing · mobile app · options-flow or
alternative data.

## 8. Success criteria
1. A fresh clone reaches a working dashboard with demo data in one command.
2. A scheduled run produces at least one correctly-sourced, correctly-explained observation on a real portfolio, with zero duplicate notifications over 72 h of continuous running.
3. A HITL proposal can be approved from Telegram and the resulting state is visible in the UI within 2 s.
4. Spot-check of 20 generated explanations: no fabricated numbers, every figure traceable to a stored data point.

## 9. Risks
| Risk | Mitigation |
|---|---|
| Unlicensed-advice framing | P2 stances, disclaimer, wording review of all output templates |
| `yfinance` is unofficial and rate-limited | provider interface + cache + fixture/paid fallbacks (see DESIGN §4) |
| LLM hallucinates numbers | numbers only ever inserted from structured data, never generated; validator rejects unsourced figures |
| Alert fatigue | thresholds, dedupe, quiet hours, digest-over-alert default |
| Scope creep via "discovery" | topic count cap, auto-discovery is proposal-only |
