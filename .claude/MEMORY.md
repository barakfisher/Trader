# Project memory — Traders

Updated: 2026-09-14. Maintained per [CLAUDE.md](../CLAUDE.md) "Session management & memory".

---

## Milestone status

| Milestone | Status | Notes |
|---|---|---|
| **M0 — Repo skeleton & contracts** | ✅ **Complete** | monorepo, compose stack, CI, OpenAPI contract + generated client |
| **M1 — Vertical slice: portfolio in, valued portfolio out** | ✅ **Complete** (pending milestone quiz) | built and verified end to end against the running stack |
| M2 — Analysis engine & observations | ⏭️ Next | rule layer, news ingestion, correlation, narration behind the evidence validator |
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
