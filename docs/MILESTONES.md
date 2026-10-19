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

*As built:* Mastra was adopted for `proposalLifecycle` only (decision 11) and retired in migration
0039 (decision D11): the `proposals` row, `applyDecision` and the `proposal_sweep` run are the whole
lifecycle, and the local trigger is an in-process timer calling the same entrypoint.

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
*(As built, decisions 90-91: the key is `universe-rescreen:<date>` for the button and the CronJob
alike, and the CronJob asks hourly - like every other run here - while the endpoint rescreens
only when the snapshot last loaded is a quarter old. A once-a-quarter trigger is lost whenever the
cluster is down that minute.)*

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
  *(As built: M8 shipped this with triggers only (decision 84), because every service connected as
  the superuser that owns the table, and a grant cannot bind a superuser. It became true as written
  with migration 0033 (independent task 9): the services connect as `traders_app`, and an UPDATE
  is refused by privilege before any trigger runs.)*

**Exit:** a non-admin session gets `403` on every `/admin/*` route (proved by a test that
enumerates them); the rescreen button and the CronJob produce the same single run; the panel shows
per-agent latency, tokens, cost and fallback reasons from real calls; a searched missing ticker
appears as a gap event and is **profiled** within one background fetch (it was priceable already;
decision 85).

---

## M9 — Multiple users *(planned 2026-10-14; PR 1 measured 2026-10-15; decisions 155-163 on 2026-10-18)*

Added at the user's request. The data model has been multi-tenant since M1 (`user_id` on every
user-owned row, guideline 5) and DESIGN §2 deferred real multi-user auth "but not designed out";
this milestone is that deferred work. What still assumes one account today:

- `SINGLE_USER_ID` (`config.ts`) - the login route signs in as that one user, and
  `POST /internal/runs` falls back to it when a run names no user.
- Passphrase login with one shared passphrase; the session is a self-describing signed cookie with
  no session table (`http/auth.ts`), so a session cannot be revoked before it expires.
- Scheduled scans run for `SINGLE_USER_ID` only (debt table in `.claude/MEMORY.md`); per-user
  fairness on the queue needs BullMQ Pro's groups (D73).
- "Today" resolves in `APP_TIMEZONE`, one zone for the installation - and guideline 10 in
  `CLAUDE.md` is written around it. Several users means a zone per user, which amends a guideline.

**PR 1 - measure, read-only, before any design.** Every query, route, run kind, cache key, budget
and notification path that assumes one user, listed with where it is. Nothing is decided before
this list exists. *Done 2026-10-15: [M9-MEASUREMENT.md](M9-MEASUREMENT.md).*

**Decisions to bring, each with a recommendation, after PR 1:**
- **Who the users are** - *decided (155):* trusted people - household and friends - on the
  self-hosted installation, reached over Tailscale; the user is its one admin. Invited strangers
  are M10. Billing stays out of scope either way (PRD §7).
- **Accounts and login** - *decided (156, 159):* email and password (argon2id, a maintained
  package). A new user signs up into `pending`; the admin approves or rejects from Telegram
  (three buttons: default budget, reject, custom budget) or the Admin page. A pending user has no
  agent and no scans; a rejected request is kept as `rejected`.
- **Sessions** - *decided (160):* the signed cookie stays and carries a `session_version`; every
  request reads the user and accepts the session only while it is `active` and the versions
  match. Disabling or rejecting a user ends their sessions at once; a password change ends all of
  theirs. No sessions table (M10 may add one for per-device sign-out).
- **Scheduling** - *decided (161):* triggers say `for: "every_active_user"` and the endpoint
  fans out per active user; a body naming no user and no fan-out is refused. Due scans are
  enqueued round-robin across users. `backfill`, `news_collect`, `instrument_metadata` and
  `proposal_sweep` run once for the installation, over the union of active users' instruments.
- **Shared costs** - *decided (157, 158):* a monthly LLM spend cap per non-admin user, in the
  user's time zone, set at approval (default from `installation_settings`, $10). Checked before
  each call against the call's maximum cost; a capped user's agent scans and `/ask` are refused
  with a reason, and narration falls back to the template so alerts still arrive. The per-agent
  and assistant allowances and the installation ceiling stay underneath.
- **Telegram** - one bot, a binding per user (the binding is already per `user_id`).
- **Admin** - *decided (162):* operations only - a user list (status, cap, spent, last sign-in)
  and runs, gaps and LLM calls per user without prompts or completions; never holdings,
  proposals, observations, agents or conversations. Account reset becomes each user's own. The
  admin can set a one-time password, changed at the next sign-in. The operator can still read
  the database; this governs the app.
- **Time zone** - *decided (163):* `users.timezone`, prefilled from the browser at signup and
  editable in Settings (valid IANA names only). The AI service's two `APP_TIMEZONE` reads move to
  the user's zone, and guideline 10 is amended with them. Scan slots stay on the market's clock;
  installation runs on `APP_TIMEZONE`; the LLM ceiling on UTC. A mid-day zone change may run or
  skip one daily run once - accepted.

**The shape the decided parts imply** (a sketch; each PR measures and refines it):
- `users` gains `status` (`pending` / `active` / `rejected` / `disabled`), `password_hash`,
  `session_version`, `llm_cap_micro_usd` (null for the admin: uncapped),
  `approved_at` and `approved_by`. The primary agent is seeded on the transition to `active`,
  not on insert. `installation_settings` gains the default cap and the pending-request ceiling.
- The cap check wraps the provider in the AI service's LLM factory, beside the installation
  ceiling (`BudgetedProvider`, `llm/factory.py`), so narration, agent scans, the assistant and
  `/ask` pass through it (guideline 6). That wrapper does not know the user today; how a call
  carries its user to it is that PR's first measurement.
- The approval message is the admin's Telegram binding, in the admin's language
  (`notify/messages.ts`); its buttons carry a signed request token.

**PRs, in order** (decisions complete): the schema (0058), login (email + password, the admin's
bootstrap script, `session_version`, the one-time password; D179-D182), signup and the approval
flow together (the zone prefill, Telegram and the Admin page; D180), the cap's enforcement, scheduling per user, the time zone's reads and guideline 10,
the admin's user list and own-account reset, then the exit test.

**Exit:** two users on one installation, each seeing only their own holdings, observations,
proposals, agents and notifications - proved by a test that signs in as one user and asserts every
user-facing route returns nothing of the other's; scheduled scans run for both; and no request
path falls back to `SINGLE_USER_ID` - a run that names no user is refused, not run as the first
user (today `POST /internal/runs` does exactly that, which a signed-in test cannot see).

---

## M10 — Public access *(roadmap, added 2026-10-18; decision 155)*

Self-signup for people the admin does not know, with OAuth (Google, GitHub), automated free-tier
limits and self-service password reset - **without changing the isolated data layer** M9 relies
on. Not started; planned only after M9's exit. It brings what M9 deliberately leaves out:
internet exposure, abuse handling and holding strangers' financial data.

---

## Ordering notes
- M2 depends on M1's provider layer; M3 is independent of M2 and can be parallelised if you want.
- The Telegram bot (M4) is deliberately after observations exist — a bot with nothing to say is untestable.
- Keep every milestone shippable: no milestone leaves the system in a state that can't `compose up`.
