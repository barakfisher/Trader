# Project memory — Traders

Updated: 2026-09-16. Maintained per [CLAUDE.md](../CLAUDE.md) "Session management & memory".

---

## Milestone status

| Milestone | Status | Notes |
|---|---|---|
| **M0 — Repo skeleton & contracts** | ✅ **Complete** | monorepo, compose stack, CI, OpenAPI contract + generated client |
| **M1 — Vertical slice: portfolio in, valued portfolio out** | ✅ **Complete** | built and verified end to end against the running stack |
| **M1.5 — Trustworthy quote path** (unplanned, inserted) | ✅ **Complete** | correctness work M2 depends on; see below |
| **M2 — Analysis engine & observations** | ✅ **Complete** | PRs #12-#22; the product now finds things, explains them and shows the figures |
| M3 — RAG & educational engine | Not started | |
| M4 — Scheduling, HITL & Telegram | Not started | Mastra lands here |
| M5 — Market discovery & topics | Not started | |
| M6 — Frontend completion & polish | Not started | |
| M7 — Kubernetes & documentation | Not started | |

## Completed features

**M0**
- pnpm workspace: `apps/web`, `apps/orchestrator`, `packages/shared`, `services/ai`, `infra/*`.
- `docker compose` stack: Postgres (pgvector image), Redis, one-shot Alembic `migrate` container,
  `ai-service`, `orchestrator`, `web`. Ordering enforced by health checks, not sleeps.
- Typed config validated at boot in both services (`pydantic-settings` / `zod`), structured JSON
  logging with `request_id` propagated across the service boundary, `/healthz` + `/readyz`.
- OpenAPI schema exported from FastAPI to a committed `services/ai/openapi.json`; the TypeScript
  client is generated from it (`pnpm gen:api`). CI fails if either artefact is stale.
- CI: Python lint/tests, TS typecheck/tests/build, and a compose smoke-test job.

**M1**
- `MarketDataProvider` chain: `FixtureProvider` (offline, zero API keys) → `YFinanceProvider`,
  with a Redis cache (single-flight), per-provider rate limiting, and a last-known-good fallback
  served flagged `stale`.
- Endpoints: `POST /market/quotes`, `GET /market/instruments/resolve`, `GET /market/fx`, all
  behind the internal shared-key dependency.
- Alembic `0001_initial_portfolio`: `users`, `instruments`, `holdings`, `target_weights`,
  `quotes`, `portfolio_snapshots`, the pgvector extension, and the seeded single user.
- Orchestrator: passphrase login with an HMAC session cookie, origin check on writes, holdings
  CRUD, CSV/JSON import (preview → commit) with per-row validation and symbol resolution,
  valuation with FX, `POST /internal/runs` with run-key deduplication, daily snapshot job.
- Web: login, summary metrics, holdings table with inline quantity edit, allocation donut,
  manual add form, import wizard with per-row status and candidate pickers, visible degraded
  states (unpriced / stale), persistent disclaimer.
- Verification: 79 tests (45 orchestrator vitest, 8 web store vitest, 26 pytest) plus
  `scripts/smoke-test.sh` passing against the live containers (login, import, valuation with FX,
  snapshot, idempotency, auth rejections).

**M1.5 — trustworthy quote path** (PRs #3-#10, 2026-09-15)

Inserted between M1 and M2 after an audit of the quote path found data problems M2 would have
built on. Every item was measured before and after, not assumed.

- **Observation time** (`core/observation_time.py`): `quotes.as_of` is when a price was observed,
  not when it was fetched, floored to each provider's freshness window. Eight dashboard refreshes
  went from 70 stored rows holding 10 distinct prices, to 10.
- **Cache policy** (`core/cache_policy.py`): TTL derived from provider delay, asset class and
  market hours, the latter resolved in `America/New_York` rather than a fixed UTC window.
- **Quota accounting**: the rate limiter charges `len(symbols)` for non-batching providers and
  supports per-day ceilings. It previously charged 1 per call while making 20 requests.
- **Free-tier tuning**: crypto TTL 60s → 300s, Redis persists across restarts, a self-imposed
  `PROVIDER_DAILY_LIMITS` ceiling. Heavy use of a 20-symbol portfolio: ~14,400 → ~600 requests/day.
- **Response validation** (`packages/shared/src/ai/schemas.ts`): every AI-service response is zod
  parsed, with each schema pinned to its generated type so Python drift is a compile error. The
  `as T` cast it replaced was the largest act of faith in the codebase.
- **Snapshot integrity** (migration `0002`): snapshots record `holdings_count`, `priced_count` and
  `degraded`, so a partial day is stored marked rather than silently understated.
- **UI honesty**: the dashboard reports when prices were *observed*, not when they were fetched.
- **Target weights API** (`apps/orchestrator/src/http/routes/targets.ts`): `GET/PUT /targets` write
  the whole set transactionally, and `portfolioScan.ts` now sends the user's real targets instead
  of `{}`. Allocation drift had been implemented and unreachable: nothing could fill the table.

**M2 — analysis engine and observations** (PRs #12-#22, 2026-09-16)

- **`runs` and `observations`** (migration `0003`). Run claims moved from a process-local Map to a
  unique `run_key` INSERT, so idempotency survives a restart and works across replicas. A run that
  throws is recorded failed rather than leaving its key claimed; one abandoned by a killed process
  is reclaimed after thirty minutes.
- **LLM provider factory** with one adapter covering OpenRouter, OpenAI and Ollama, a null provider
  so running without a model is a tested path, and a daily spend guard in micro-USD. Misconfiguration
  raises at boot in production and degrades elsewhere.
- **Rule layer**: price move, sigma move, drawdown, allocation drift. Pure functions; every finding
  carries the figures it rests on.
- **News ingestion** (migration `0004`): fixture provider, dedupe on URL and content hashes, entity
  extraction that refuses a bare ticker without corroboration, deterministic lexicon sentiment.
- **Narration behind the evidence validator**: every number in generated text is checked against the
  finding's evidence, and one unsupported figure discards the whole narration. Five failure paths
  land on deterministic templates, with `fallback_reason` recorded.
- **Price-history fixture** (70 daily closes per symbol, committed, seeded by a script that shifts
  the series to end yesterday) — without it every rule correctly found nothing.
- **Scan workflow**: `POST /internal/runs {kind: portfolio_scan}`, observations stored with a
  `dedupe_key`, skips recorded as loudly as findings.
- **Scheduled scans**, with the run-key bucket deciding what counts as a repeat (snapshot daily,
  scan half-hourly) and timers that fire more often than the work is allowed to happen.
- **Target weights API**, without which allocation drift could never fire.
- **Observations feed** with an evidence drawer that renders `price_minor: 11845` as `$118.45`.

## Architectural decisions

Full reasoning in [docs/DESIGN.md](../docs/DESIGN.md) section 2. The ones that constrain future work:

1. **pgvector inside Postgres**, not a separate vector database, behind a `VectorStore` interface.
2. **REST + OpenAPI**, not gRPC; routes shaped so SSE streaming can be added without changing
   payloads.
3. **One trigger path for scheduled work**: `POST /internal/runs`. Locally a timer calls it; in
   Kubernetes a CronJob does, with `SCHEDULER_ENABLED=false` on the Deployment.
4. **Mastra deferred to M4**, with the integration points already in place — see
   `apps/orchestrator/src/mastra/README.md` for why and where.
5. **Cost basis is per unit**, not a position total; totals computed at read time.
6. **Vite SPA, not Next.js**; MobX + Recharts only.
7. **Milestone order was changed from the original brief** to ship a vertical slice first.
8. **Session auth is a signed self-describing cookie**, no session table; only `http/auth.ts` and
   the login route change when real multi-user auth arrives.
9. **No market-status API call, ever, on the pricing path.** Evaluated and rejected: the quota
   saving is near zero because fetching is demand-driven, an external check cannot replace the
   offline calendar it would need as an outage fallback, and a wrongly cached "closed" would halt
   pricing for a day - failing in the expensive direction, where the current design fails in the
   cheap one. If scheduled scans ever make holidays material, the answer is a static calendar
   applied at the scheduler, not a network call per quote.
10. **Identity is decided before narration, not after.** The rules are deterministic and the scan
    runs half-hourly, so most of what a scan finds is what the last scan found. The caller sends the
    dedupe keys it already holds and the pipeline skips those before calling a model: a repeat costs
    a hash rather than a completion. Narrating and then discarding was roughly two hundred throwaway
    model calls a day.
11. **Partial snapshots are stored and marked, not refused.** A silent hole in the equity curve is
    as misleading as an understated total; `degraded` lets every consumer tell the difference.
11. **Target weights are replaced, never patched.** A set of weights is one statement about the
    intended shape of the portfolio, and its only cross-row rule (they sum to at most 1) is a
    property of the set. A partial update could leave a combination the user never chose, and the
    drift rule would report against it as if they had. A target may name any resolved instrument,
    held or not, because "I meant 10% of this and hold none" is a real drift; it may not name a
    symbol we have never resolved, so `PUT /targets` makes no provider call and a market-data
    outage can never block someone correcting their own targets.

9. **A partially priced snapshot is stored marked, not refused** (Alembic `0002_snapshot_integrity`:
   `holdings_count`, `priced_count`, `degraded`). A hole in the series reads as "no change" and
   misleads exactly as much as an understated total; snapshots are never recomputed, so the marker
   is the only chance to say the total is incomplete. M2's volatility and drawdown rules must skip
   `degraded` points rather than explain them.

## Known issues and technical debt

| Item | Where | Impact |
|---|---|---|
| Import previews are in-process memory | `apps/orchestrator/src/services/previewStore.ts` | orchestrator must stay at `replicas: 1` until this moves to Redis |
| Run keys are in-process memory | `src/http/routes/internal.ts` | must move to the `runs` table in M2, or a restart lets a duplicate run through |
| No `runs` table yet | Alembic | M2 deliverable; the migration must also backfill idempotency |
| Web bundle is ~600 kB (Recharts) | `apps/web` | acceptable now; code-split in M6 |
| `yfinance` is unofficial and delayed | `services/ai/app/providers/yfinance_provider.py` | fine for development; add Polygon.io before relying on it |
| LLM provider factory not built yet | — | M2; must be an interface from the first line (CLAUDE.md guideline 6) |
| Quote history written best-effort | `routes/portfolio.ts` | failures are logged, not retried; fine until M2 needs dense history |
| No rate limiting on public API routes | `src/http/app.ts` | single-user deployment; revisit before multi-user |
| No component/DOM tests on the web app | `apps/web/test` | store logic is covered; rendering is not. Add a DOM test runner in M6 |
| Crypto detection is a symbol-shape heuristic | `core/cache_policy.py` | `-USD` suffix, because the AI service receives bare symbols. Fix by passing `asset_class` and `exchange` on the quote request |
| Market hours assume US sessions for every symbol | `core/cache_policy.py` | SAP.DE trades on XETRA (08:00-16:30 UTC) but is judged against NYSE hours: ~5 hours a day of needlessly stale prices. Same wire change fixes it |
| Explanation provenance is invisible | `observations` | Nothing records whether a sentence was written by a model or a template, so the UI cannot show it and a reader cannot weigh it. Needs a column |
| Concept chips point nowhere | `apps/web` | FR-16 wants one click to an explanation; the corpus arrives in M3 |
| No UI for target weights | `apps/web` | The API exists and is tested; setting them still requires curl |
| Redis cold start refetches everything | `core/cache.py` | the `quotes` table holds usable recent prices; warming from it was deferred to pair with M2 |
| `instruments` and `quotes` have no `user_id` | migration `0001` | intentional: shared reference and market data, not user-owned. Documented so the audit does not re-flag it |
| Snapshots written before `0002` carry default counts | migration `0002` | `holdings_count = 0` on a non-zero total means "provenance unknown"; not backfilled, and `0002` has not yet run against a live database |

## Developer entry points

- `bash scripts/dev-docker.sh` — everything in containers. The default. `--rebuild`, `--reset`
  (destroys the database, asks first), `--logs`, `--stop`.
- `bash scripts/dev-local.sh` — Postgres and Redis in containers, the three application processes
  native with hot reload. `--setup` installs dependencies only. It stops the containerised app
  services first so both cannot run at once, and refuses to start if a port it needs is taken.
- Shared helpers in `scripts/lib/dev-common.sh`: `.env` bootstrap with generated secrets,
  readiness polling, and a port check that probes the exact bind address (IPv4 loopback) rather
  than the port number, because another process may hold only the IPv6 address.

## Local environment notes (this machine)

- Other processes on this Mac hold 5432, `127.0.0.1:8000`, and `[::1]:5173` / `[::1]:5174`. All
  published ports are therefore configurable; this machine's `.env` uses
  `POSTGRES_HOST_PORT=55432`, `WEB_HOST_PORT=5174`, `AI_SERVICE_HOST_PORT=8001`, and
  `VITE_API_BASE_URL=http://127.0.0.1:8080`.
- Reach the dashboard at **http://127.0.0.1:5174**, not `localhost` (IPv6 resolves first).
- A stale Vite dev server from the directory's previous project
  (`/Users/a/projects/Traders/frontend/node_modules/.bin/vite`, pid 36957 as of 2026-09-14) still
  holds `[::1]:5173`. Killing it would free the default port; left alone pending the user's call.
