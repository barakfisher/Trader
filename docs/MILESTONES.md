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

**Exit:** a free-text topic resolves to a sensible confirmed instrument set and produces topic observations; a rejected auto-proposal never returns.

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

## Ordering notes
- M2 depends on M1's provider layer; M3 is independent of M2 and can be parallelised if you want.
- The Telegram bot (M4) is deliberately after observations exist — a bot with nothing to say is untestable.
- Keep every milestone shippable: no milestone leaves the system in a state that can't `compose up`.
