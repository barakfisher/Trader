# Design & Architecture

**Status:** Draft v0.1 · Companion to [PRD.md](PRD.md) and [FLOWS.md](FLOWS.md)

---

## 1. Service topology

```
                      ┌──────────────────────────┐
  Telegram  ◄────────►│  telegram webhook route  │
                      │                          │
  Browser   ◄────────►│  REST API (Hono)         │
                      └────────┬─────────────────┘
                               │  orchestrator: workflows, cron, HITL
                               │  state machine, notification fan-out
                               │
                        REST (OpenAPI, typed client)
                               │
                      ┌────────▼─────────────────┐
                      │  ai-service (FastAPI)    │
                      │  quotes · news · NER ·   │
                      │  sentiment · RAG · Q&A   │
                      └────┬──────────────┬──────┘
                           │              │
              market/news providers    Postgres + pgvector
                                       (shared, schema-separated)
```

Three deployables: `web` (static SPA), `orchestrator` (Node/TS, Hono), `ai-service` (Python).
One datastore: Postgres. One cache/queue: Redis.

## 2. Decisions (and what was rejected)

| Area | Decision | Why / rejected alternative |
|---|---|---|
| Frontend | **Vite + React + TS SPA**, Tailwind, MobX, Recharts | Next.js SSR buys nothing for an auth-walled dashboard and fights MobX observables; Recharts only — no second chart lib |
| Service RPC | **REST + OpenAPI**, TS client generated from FastAPI's schema | gRPC adds toolchain cost for two services with no streaming need; we get types for free from FastAPI |
| Vector store | **pgvector inside Postgres** behind a `VectorStore` interface | one fewer container, transactional writes with the rest of the domain; Qdrant remains a drop-in swap if hybrid search outgrows pgvector |
| Relational store | **Postgres** (not SQLite) | concurrent writers (cron + API + webhook), JSONB evidence blobs, pgvector |
| Ownership of schedule | **The orchestrator owns run logic; the *trigger* is external** — local: an in-process timer; K8s: CronJob → `POST /internal/runs` | two schedulers (a local timer *and* a K8s CronJob) would double-fire; one trigger path, dedupe on run key |
| HITL mechanism | A durable `proposals` row is the question and its deadline; `applyDecision` answers it, `proposal_sweep` expires it. (Mastra `suspend`/`resume` sat beside it from M4 and was retired in 0039, decision D11: every path already fell back to the row.) | never trust in-memory suspension across restarts |
| LLM access | single gateway module, provider-agnostic (OpenRouter / Anthropic / OpenAI / local Ollama fallback) | keys already present in `.env`; model choice must not leak into business logic |
| Auth (v1) | single account, session cookie from a passphrase login; `user_id` present on every table | real multi-user auth deferred but not designed out |
| Money | integer minor units + explicit currency; `Decimal` in Python, never float | float drift in P&L is unacceptable |

## 3. Data model (Postgres, core tables)

```
users(id, email, base_currency, quiet_hours, created_at)
instruments(id, symbol, asset_class, exchange, currency, name, provider_ids jsonb)
holdings(id, user_id, instrument_id, quantity numeric, cost_basis_minor, currency, opened_at)
target_weights(user_id, instrument_id, weight)           -- optional, drives drift detection
portfolio_snapshots(id, user_id, as_of, total_minor, cost_minor, currency, breakdown jsonb,
                    holdings_count, priced_count, degraded)   -- see note below
quotes(instrument_id, as_of, price_minor, currency, source, delay_seconds)  -- time-series, retained N days

topics(id, user_id, label, status[active|proposed|rejected], created_by[user|auto])
topic_instruments(topic_id, user_id, instrument_id, source[resolver|user], confidence, rationale, held_by)  -- confirmed rows only (migration 0017)

articles(id, url_hash unique, url, source, published_at, title, raw_text, content_hash)
article_entities(article_id, instrument_id|topic_id, kind, salience)
article_sentiment(article_id, score, magnitude, model, created_at)

observations(id, user_id, kind, severity, subject_ref, headline, explanation,
             evidence jsonb, concept_refs text[], run_id, created_at, dedupe_key unique)
proposals(id, user_id, observation_id, kind, payload jsonb,
          state[pending|approved|rejected|snoozed|expired], expires_at,
          decided_at, decided_via[ui|telegram], decided_by)
intents(id, proposal_id, kind, payload jsonb, created_at)   -- the "execution" ledger (paper only)
runs(id, kind, trigger, started_at, finished_at, status, stats jsonb, run_key unique)
notifications(id, user_id, channel, ref_kind, ref_id, sent_at, dedupe_key unique)

kb_documents(id, source, title, uri, license)              -- RAG corpus
kb_chunks(id, document_id, ord, text, embedding vector, metadata jsonb)
```

Indices that matter: `observations(dedupe_key)`, `notifications(dedupe_key)`, `runs(run_key)`,
`articles(url_hash)`, `kb_chunks` HNSW on `embedding`, `quotes(instrument_id, as_of desc)`.

Two columns carry more meaning than their names suggest:

- **`quotes.as_of` is when the price was *observed*, not when it was fetched.** Providers that
  publish a trade timestamp supply it; for the rest it is the fetch time floored to that provider's
  freshness window (`quote_granularity_seconds`). This is what makes the `(instrument_id, as_of)`
  primary key deduplicate repeated reads of one observation, and it keeps the stored time from
  claiming precision the data does not have. Stamping `now()` here produced 70 rows holding 10
  distinct prices, and would have misdated every move Milestone 2 derives from the series.
- **`portfolio_snapshots.degraded`** records that the day's total was computed while something was
  unpriced or served stale. A snapshot is a historical fact that is never recomputed, so an
  understated total would leave a permanent phantom crash in the equity curve - and the analysis
  engine would later detect that crash and explain it, citing our own data. Partial snapshots are
  stored *marked* rather than refused, because a silent hole in the series is equally misleading.
  Rows predating this column are backfilled `degraded = true`: unknown provenance is closer to
  degraded than to trustworthy.

## 4. Provider layer (ai-service)

```python
class MarketDataProvider(Protocol):
    def quote(self, symbols: list[str]) -> list[Quote]: ...
    def history(self, symbol: str, period: str) -> Series: ...
```
**Cache policy** (`app/core/cache_policy.py`): a quote's TTL follows the data rather than the
clock. Crypto trades continuously, so it is capped by how often we are willing to ask (300s).
Equities take the provider's own declared delay while the market is open - caching for less than
that re-reads a value that cannot have changed - and one hour when it is closed. Market hours are
resolved in `America/New_York`, not a fixed UTC window, because the session shifts by an hour twice
a year and a stale window silently serves hour-old prices through the last hour of a winter trading
day. Public holidays are deliberately ignored: the cost is a handful of extra requests roughly ten
days a year, against a calendar that is either a dependency or a table that rots.
A fill is different - a closed Thanksgiving read as an open Thursday fills at a price nobody could
trade at - so trades ask the **exchange calendar** instead (`app/core/exchange_calendar.py`,
decision D25 of `PROPOSAL-MULTI-AGENT.md`): a committed `data/calendar/xnys.json` written from
NYSE's rules by `scripts/generate_exchange_calendar.py`, with a test that fails 90 days before it
runs out. The cache keeps ignoring holidays; only the trading path pays for knowing them.

**Quota accounting**: the rate limiter is charged what a call actually costs - `len(symbols)` for a
provider that issues one request per symbol, 1 for one with a multi-symbol endpoint
(`batches_requests` on the provider contract). Charging per call while making one request per
symbol under-reported usage by the batch size, which is to say the mechanism protecting the budget
was reporting a twentieth of the truth. Per-day ceilings (`PROVIDER_DAILY_LIMITS`) exist because
free tiers cap by day and a per-minute limiter cannot see that.

Implementations, tried in order per config: `FixtureProvider` (offline/CI/demo) →
`YFinanceProvider` (dev default; unofficial, treat as best-effort) →
`AlphaVantageProvider` / `FinnhubProvider` (keyed, hard daily caps) →
`CoinGeckoProvider` (crypto). Every provider call goes through a Redis cache with a
per-kind TTL (quote 60 s, daily history 12 h, news 15 min) and a token-bucket limiter keyed
by provider. Cache-miss storms are collapsed with a per-key lock. News uses the same shape
via `NewsProvider`.

## 5. Analysis pipeline (one scheduled run)

1. `runs` row created with a `run_key` = `{kind}:{user}:{bucket}` — duplicate trigger = no-op.
2. Refresh quotes + FX for held and topic-linked instruments (batched, cached).
3. **Rule layer (deterministic, no LLM):** price move vs thresholds, σ-move, volume anomaly, drawdown, allocation drift. Emits candidate findings with exact numbers.
4. **News layer:** fetch → dedupe by `url_hash`/`content_hash` → extract entities (ticker/company/topic resolution) → sentiment → link to instruments/topics.
5. **Correlation:** join price findings with same-window news to answer "why".
6. **Narration (LLM):** turns a finding + its evidence into headline + explanation. Numbers are interpolated from the evidence struct; a validator rejects any figure in the output that is not present in the evidence.
7. **Concept linking:** attach `concept_refs` resolved against the RAG corpus.
8. **Dedupe + throttle:** `dedupe_key = hash(kind, subject, bucket, severity)`; suppress if an equivalent observation was emitted within the cool-off window.
9. Persist observations; create proposals where a finding is actionable; hand off to notification fan-out (respects quiet hours; batches into digest unless severity is high).

### 5.1 What makes a claim shippable

Steps 6 to 8 above are the part worth stating precisely, because they are where the product's
central rule is enforced rather than described.

**Evidence first.** Each rule emits a `Finding` carrying the figures it rests on: both prices and
their observation times, the computed statistic, the thresholds applied, and whether any floor was
used. Nothing downstream may state a number that is not in there.

**Identity before words.** A finding's `dedupe_key` hashes the rule, the subject, the severity and
the day the observed data belongs to - from the finding's own `as_of`, never a clock. The caller
sends the keys it already holds, so a repeat is dropped before anything is narrated: the rules are
deterministic and the scan runs half-hourly, so most of what a scan finds is what the last one
found, and narrating those meant paying a model to write sentences that were discarded on insert.
**States are the exception** (decision 132): drawdown and allocation drift describe where a subject
*is*, so a day bucket repeated them daily. Each belongs to an episode (`finding_episodes`, 0049)
holding the highest band it has written; the caller sends the open episodes too, and a state is
written again only above its episode's band. The episode ends when a scan that measured the subject
finds nothing - below the `info` band - and the next entry is new. One move is also one finding: when
`sigma_move` fires, `price_move` is dropped; it stands alone when the sigma rule is silent.

**Narration last, and least trusted.** The model is offered a finding whose deterministic narration
already exists and is correct. Every number in what it returns is checked against the evidence, with
tolerance for how a number is *written* (minor units rendered as major, ratios as percentages,
rounding at the writer's precision, a dropped sign) but none for a different number. One unsupported
figure discards the whole narration; partial trust in a sentence is not something this product can
offer. Five paths - no provider, budget exhausted, provider error, malformed reply, unsourced
figures - land on the same deterministic template, and `fallback_reason` records which, so the
rejection rate is measurable rather than anecdotal.

**Skips are reported as loudly as findings.** A scan that produced nothing because allocation drift
had no targets configured is a different thing from a quiet market, and an empty feed cannot tell
them apart. A run finishes `degraded` rather than `ok` whenever a rule declined to run or a holding
could not be priced.

## 6. RAG design

- **Corpus:** curated, licence-clean financial concept material + our own written explainers, plus ingested article text (separate namespace, never mixed with definitions).
- **Chunking:** structure-aware (heading + ~700 tokens, 15 % overlap); each chunk keeps `concept_id` metadata.
- **Retrieval:** hybrid — pgvector cosine + Postgres full-text, reciprocal-rank fused, then a small reranker. Namespace filter (`concepts` vs `news`) chosen by query intent.
- **Answering:** portfolio questions get structured portfolio context injected (not retrieved); concept questions get retrieved chunks. Answers cite chunk sources; below a relevance floor the answer is "I don't have that indexed".

## 7. Orchestrator

- **Run kinds:** `portfolio_scan`, `topic_scan`, `daily_digest`, `proposal_sweep` and the rest, all entering through `POST /internal/runs` with a run key.
- **HITL:** a proposal is a row with a deadline. The UI and Telegram both call `applyDecision`; the sweep expires what nobody answered. A restart loses nothing, because nothing waits in memory.
- **Notification fan-out:** channel adapters (`ui`, `telegram`) behind one interface; `notifications.dedupe_key` makes resend safe.
- **Telegram:** webhook with secret-token validation; `callback_data` carries `{proposal_id, action, nonce}` HMAC-signed, single-use (nonce burned in Redis), TTL-checked against `proposals.expires_at`.

## 8. Repo layout (pnpm workspace + uv-managed Python)

```
Traders/
├─ docs/                  PRD.md · DESIGN.md · FLOWS.md · MILESTONES.md
├─ apps/
│  ├─ web/                Vite + React + MobX + Tailwind
│  └─ orchestrator/       Node/TS: API, runs, proposals, telegram
├─ services/
│  └─ ai/                 FastAPI + LangChain: providers, pipeline, RAG
├─ packages/
│  └─ shared/             TS types, generated API client, zod schemas
├─ infra/
│  ├─ docker/             Dockerfiles
│  ├─ compose/            docker-compose.yml (+ .override for dev)
│  └─ k8s/                deployments, services, configmaps, secrets, cronjobs, hpa
├─ data/fixtures/         offline market/news fixtures, demo portfolio, seed corpus
└─ .env.example
```

## 9. Cross-cutting
- **Config:** one typed config module per service, validated at boot (zod / pydantic-settings); boot fails loudly on a missing required key.
- **Observability:** structured JSON logs with `request_id` + `run_id` propagated via header; LangSmith traces for LLM calls; `/healthz` + `/readyz` on both services.
- **Testing:** ai-service — pytest with the fixture provider, golden-file tests on the analysis pipeline, eval set for RAG answers; orchestrator — vitest on the state machine + workflow integration tests against a throwaway Postgres; web — component tests on the critical widgets. CI runs all three from M1.
- **Migrations:** Alembic owns the schema (ai-service ships it); orchestrator reads/writes via the same schema with its own typed queries.

## 10. Security
Passphrase login + httpOnly session cookie · CSRF on state-changing routes · `/internal/*`
routes reachable only in-cluster + shared-secret header · Telegram binding tokens signed and
single-use · outbound URL allowlist for article fetching (SSRF) · article text is *data*:
never treated as instructions by any prompt, and prompts state so explicitly · no secret in
any client bundle.
