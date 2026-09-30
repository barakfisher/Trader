# Milestones

Reordered from the original brief so that a **thin vertical slice ships first** — the original
plan put the frontend at M4, which means ~4 milestones with nothing you can look at, and it
hides integration problems until late. Each milestone below ends in something runnable and
demoable, with explicit exit criteria.

---

## M0 — Repo skeleton & contracts *(0.5 day)*
- Monorepo layout per DESIGN §8, pnpm workspace, `git init`, `.env.example`, README.
- `docker-compose.yml`: Postgres (pgvector image), Redis, `orchestrator`, `ai-service`, `web`.
- Both services boot with typed config validation, `/healthz`, structured logging with `request_id`.
- OpenAPI contract stub for the two endpoints M1 needs; generated TS client wired into `packages/shared`.
- CI: lint + typecheck + test on all three workspaces (green on an empty test suite is fine).

**Exit:** `docker compose up` → both `/healthz` green, `web` serves a shell page, CI green.

---

## M1 — Vertical slice: portfolio in, valued portfolio out *(2–3 days)*
- ai-service: `MarketDataProvider` interface + `FixtureProvider` + `YFinanceProvider`, Redis cache, rate limiter. `POST /quotes`, `GET /instruments/resolve`.
- Alembic migrations for `users`, `instruments`, `holdings`, `quotes`, `portfolio_snapshots`.
- orchestrator: passphrase login + session, holdings CRUD, CSV/JSON import with preview & per-row validation, valuation with FX, daily snapshot job.
- web: login, holdings table with live value/P&L, import wizard, one chart (allocation).
- Demo portfolio fixture so the whole flow works with **zero API keys**.

**Exit:** upload the demo CSV → see a valued portfolio and allocation chart; `pytest`/`vitest` cover the import edge cases (bad symbol, bad quantity, duplicate row, mixed currency).

---

## M2 — Analysis engine & observations *(3–4 days)*
- Rule layer: thresholds, σ-move, volume anomaly, drawdown, allocation drift — deterministic, golden-file tested.
- `NewsProvider` + ingestion: fetch, dedupe (`url_hash`/`content_hash`), entity extraction, sentiment.
- Correlation + LLM narration behind the **evidence validator** (no figure that isn't in the evidence).
- `observations` with `dedupe_key`, `runs` with `run_key`; run triggered manually via `POST /internal/runs`.
- web: observations feed with evidence drawer.

**Exit:** manual run on a real portfolio yields sourced, explained observations; running it twice in a row produces zero new rows.

---

## M3 — RAG & educational engine *(3 days)*
- Corpus ingestion CLI, structure-aware chunking, pgvector + HNSW, hybrid retrieval (vector + FTS + RRF + rerank).
- `POST /ask` with intent routing (portfolio vs concept), citations, relevance floor.
- Concept linking on observations; term-hover explanations in the UI.
- Small eval set (~30 Q/A) run in CI as a regression check.

**Exit:** every observation has working concept links; `/ask` answers concept and portfolio questions with citations and correctly refuses out-of-index questions.

---

## M4 — Scheduling, HITL & Telegram *(3–4 days)*
- Mastra workflows: `portfolioScan`, `topicScan`, `dailyDigest`, `proposalLifecycle` (suspend/resume, Postgres-backed recovery).
- Proposal state machine with TTL, snooze, idempotent transitions, audit trail.
- Telegram: signed binding deep link, webhook with secret token, signed single-use callbacks, inline approve/reject, `/portfolio`, `/pending`, `/mute`, `/stop`.
- Notification fan-out: severity routing, quiet hours, digest batching, `notifications.dedupe_key`.
- Cron trigger local (Mastra) with the same entrypoint K8s will call.

**Exit:** scheduled runs go 72 h unattended with no duplicate alerts; a Telegram approval is visible in the UI within 2 s; a replayed callback is a no-op.

---

## M5 — Market discovery & topics *(2–3 days)*
- Topic CRUD, resolution to candidate instruments with confidence + rationale, user confirmation.
- Auto-discovery of themes (proposal-only), rejection memory.
- Per-topic sentiment trend, topic cards, digest topic section.
- Resolution design, measurements and the improvement backlog: [TOPIC_RESOLUTION.md](TOPIC_RESOLUTION.md).

**Exit:** a free-text topic resolves to a sensible confirmed instrument set and produces topic observations; a rejected auto-proposal does not return within the rejection cooldown (`TOPIC_REJECTION_COOLDOWN_DAYS`, default 90).

*Amended 2026-09-27:* the criterion originally said "never returns". Rejection memory is a cooldown by
the user's decision, because interests change; the rejected row itself is kept. See MEMORY.md decision 56.

---

## M6 — Frontend completion & polish *(2–3 days)*
- Equity curve, per-holding detail view, proposals inbox, topic management, settings (thresholds, quiet hours, base currency).
- MobX store structure finalised, loading/error/empty states everywhere, mobile-width pass, disclaimer surfaces.
**Exit:** every PRD user-facing FR reachable from the UI; no dead ends or unhandled error states.

---

## M7 — Kubernetes & documentation *(2 days)*
- K8s manifests: Deployments, Services, ConfigMaps, Secrets, Ingress, CronJobs (hitting `/internal/runs`), HPA on the two services, probes, resource requests/limits.
- Image build pipeline, migration job ordering, one-command local cluster (kind/minikube) verification.
- README with architecture diagram, runbook (rotate keys, replay a run, recover a stuck proposal), ADR index, cost notes.

**Exit:** clean deploy to a local kind cluster, CronJob fires a real run, docs let a stranger run it.

---

## M8 — Admin operations & observability *(post-M7, 4–6 days)*

Placed after M7, not M6: the quarterly rescreen is a K8s CronJob and the on-demand rescreen is a
Job, and both need M7's `/internal/runs` wiring. Written against the stack as it exists; where the
original brief named something this repository does not have, the reconciliation is stated.

**1. Admin surface (prerequisite for the rest)**
- `users.role` (`'user' | 'admin'`, default `'user'`); the v1 passphrase account is migrated to
  `admin`. The role travels in the server-side session, never in anything the browser can edit.
- Enforcement is in the **orchestrator's routing layer**, the only browser-facing API: every
  `/admin/*` route sits behind one guard that returns `403` for a valid non-admin session and `401`
  for none. The AI service stays internal-only. A route test enumerates every registered `/admin/*`
  path and asserts the guard, so a new route cannot ship unguarded.
- Universe status: `as_of`, instrument count, equity/ETF split — read from the database
  (`instrument_profiles`, `etf_holdings`), with the snapshot manifest shown beside it so a
  database/file disagreement is visible rather than silent.
- Gap monitoring, as rows in an `ops_events` table (`kind`, `detail jsonb`, `occurred_at`,
  `dedupe_key`):
  - `UNIVERSE_GAP_MISSING_TICKER` — a symbol a user searched for or imported that is not in the
    universe.
  - `UNIVERSE_GAP_LOW_CONFIDENCE` — a topic resolution whose candidates all fell below the gate.
    (The resolver has a relative gate, not one fixed similarity threshold; the event records the
    gate and the best score so the threshold question can be asked of real data.)
  - Narration rejections — **already recorded** as `observations.fallback_reason`; the panel is a
    query over that column, not a new log.
  - Events carrying a user's query text are user data and carry `user_id` (guideline 5).
- "Rescreen universe": enqueues a run via `POST /internal/runs` with run key
  `universe-rescreen:<date>`, so a double click, two admins or a retry is one run (guideline 8),
  and at most one rescreen is in flight. Runs `build_instrument_universe.py` (~1 h of Yahoo
  fetching, resumable) then `ingest_universe.py`. The dependency this once had, a universe
  unreachable from the running stack, was resolved in #53: the image carries `data/universe`,
  and the compose `universe` service loads it. The rescreen still needs somewhere outside the
  image to keep the descriptions it fetches, because they are licensed and never baked in.

**2. LLM observability**
- An `llm_calls` table written by the provider factory for every call: agent (`narration`, `ask`,
  topic resolution), provider, model, latency, prompt/completion tokens, cost from `pricing.py`
  (integer minor units, guideline 3), outcome. Prompts and completions are stored too; because they
  contain portfolio data, rows carry `user_id` and expire after a retention window.
- Fallback health uses the real reason set: `no_provider`, `budget_exhausted`, `provider_error`,
  `malformed`, `unsourced_figures`. (The brief's `rate_limited` is `provider_error` today; split it
  out only if the panel needs it.)
- Native panel first. Langfuse/Phoenix are optional **self-hosted** exporters behind an interface;
  a hosted tracer would ship user holdings to a third party.
- Not in scope until they exist: **TTFT** (calls do not stream — `app/llm/base.py`) and **semantic
  cache hit rate** (there is no semantic cache). Both are listed so they are not measured as zero.

**3. Quarterly baseline refresh** — a K8s CronJob hitting `/internal/runs` with
`universe-rescreen:<quarter>`, the same job the button triggers. "Rebalancing" here means
recomputing universe membership and ETF weights; it never touches a user's holdings or proposals.

**4. On-demand ingestion (fast path)** — a missing ticker is fetched from Yahoo in the background
and written with `membership = 'on_demand'`, not `'screened'`: it was never screened, so it is
described but excluded from topic resolution until a rescreen admits or drops it. The user's
import or topic flow never waits on it; the `MISSING_TICKER` event is logged either way.
*(As built, decisions 85 and 89: a missing ticker was already priceable - symbol lookup asks Yahoo
live - so what the fetch adds is the **profile**. A listing the screen excludes by rule, and one
nothing could price, is not fetched.)*

**5. Isolation and audit**
- Universe and market data stay unscoped (no `user_id`), as today.
- `admin_audit` (`admin_user_id`, `action`, `detail`, `ip_address`, `occurred_at`) is append-only:
  the application role has `INSERT`/`SELECT` only, so immutability is enforced by Postgres, not by
  convention.

**Exit:** a non-admin session gets `403` on every `/admin/*` route (proved by a test that
enumerates them); the rescreen button and the CronJob produce the same single run; the panel shows
per-agent latency, tokens, cost and fallback reasons from real calls; a searched missing ticker
appears as a gap event and is **profiled** within one background fetch (it was priceable already;
decision 85).

---

## Ordering notes
- M2 depends on M1's provider layer; M3 is independent of M2 and can be parallelised if you want.
- The Telegram bot (M4) is deliberately after observations exist — a bot with nothing to say is untestable.
- Keep every milestone shippable: no milestone leaves the system in a state that can't `compose up`.
