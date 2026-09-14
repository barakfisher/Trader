# Design & Architecture

**Status:** Draft v0.1 · Companion to [PRD.md](PRD.md) and [FLOWS.md](FLOWS.md)

---

## 1. Service topology

```
                      ┌──────────────────────────┐
  Telegram  ◄────────►│  telegram webhook route  │
                      │        (Mastra)          │
  Browser   ◄────────►│  REST API (Hono/Mastra)  │
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

Three deployables: `web` (static SPA), `orchestrator` (Node/TS, Mastra), `ai-service` (Python).
One datastore: Postgres. One cache/queue: Redis.

## 2. Decisions (and what was rejected)

| Area | Decision | Why / rejected alternative |
|---|---|---|
| Frontend | **Vite + React + TS SPA**, Tailwind, MobX, Recharts | Next.js SSR buys nothing for an auth-walled dashboard and fights MobX observables; Recharts only — no second chart lib |
| Service RPC | **REST + OpenAPI**, TS client generated from FastAPI's schema | gRPC adds toolchain cost for two services with no streaming need; we get types for free from FastAPI |
| Vector store | **pgvector inside Postgres** behind a `VectorStore` interface | one fewer container, transactional writes with the rest of the domain; Qdrant remains a drop-in swap if hybrid search outgrows pgvector |
| Relational store | **Postgres** (not SQLite) | concurrent writers (cron + API + webhook), JSONB evidence blobs, pgvector |
| Ownership of schedule | **Mastra owns workflow logic; the *trigger* is external** — local: Mastra cron; K8s: CronJob → `POST /internal/runs` | two schedulers (Mastra cron *and* K8s CronJob) would double-fire; one trigger path, dedupe on run key |
| HITL mechanism | Mastra workflow `suspend`/`resume` + a durable `proposals` table as source of truth | never trust in-memory suspension across restarts |
| LLM access | single gateway module, provider-agnostic (OpenRouter / Anthropic / OpenAI / local Ollama fallback) | keys already present in `.env`; model choice must not leak into business logic |
| Auth (v1) | single account, session cookie from a passphrase login; `user_id` present on every table | real multi-user auth deferred but not designed out |
| Money | integer minor units + explicit currency; `Decimal` in Python, never float | float drift in P&L is unacceptable |

## 3. Data model (Postgres, core tables)

```
users(id, email, base_currency, quiet_hours, created_at)
instruments(id, symbol, asset_class, exchange, currency, name, provider_ids jsonb)
holdings(id, user_id, instrument_id, quantity numeric, cost_basis_minor, currency, opened_at)
target_weights(user_id, instrument_id, weight)           -- optional, drives drift detection
portfolio_snapshots(id, user_id, as_of, total_minor, currency, breakdown jsonb)
quotes(instrument_id, as_of, price_minor, currency, source, delay_seconds)  -- time-series, retained N days

topics(id, user_id, label, status[active|proposed|rejected], created_by[user|auto])
topic_instruments(topic_id, instrument_id, confidence, confirmed_by_user bool)

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

## 4. Provider layer (ai-service)

```python
class MarketDataProvider(Protocol):
    def quote(self, symbols: list[str]) -> list[Quote]: ...
    def history(self, symbol: str, period: str) -> Series: ...
```
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

## 6. RAG design

- **Corpus:** curated, licence-clean financial concept material + our own written explainers, plus ingested article text (separate namespace, never mixed with definitions).
- **Chunking:** structure-aware (heading + ~700 tokens, 15 % overlap); each chunk keeps `concept_id` metadata.
- **Retrieval:** hybrid — pgvector cosine + Postgres full-text, reciprocal-rank fused, then a small reranker. Namespace filter (`concepts` vs `news`) chosen by query intent.
- **Answering:** portfolio questions get structured portfolio context injected (not retrieved); concept questions get retrieved chunks. Answers cite chunk sources; below a relevance floor the answer is "I don't have that indexed".

## 7. Orchestrator (Mastra)

- **Workflows:** `portfolioScan`, `topicScan`, `dailyDigest`, `proposalLifecycle`, `onboardImport`.
- **HITL:** `proposalLifecycle` suspends after emitting the proposal; UI/Telegram decision resumes it by proposal id. On process restart, pending proposals are recovered from Postgres, not from memory.
- **Notification fan-out:** channel adapters (`ui`, `telegram`) behind one interface; `notifications.dedupe_key` makes resend safe.
- **Telegram:** webhook with secret-token validation; `callback_data` carries `{proposal_id, action, nonce}` HMAC-signed, single-use (nonce burned in Redis), TTL-checked against `proposals.expires_at`.

## 8. Repo layout (pnpm workspace + uv-managed Python)

```
Traders/
├─ docs/                  PRD.md · DESIGN.md · FLOWS.md · MILESTONES.md
├─ apps/
│  ├─ web/                Vite + React + MobX + Tailwind
│  └─ orchestrator/       Mastra (Node/TS): API, workflows, cron, telegram
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
