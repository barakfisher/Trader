# Project memory — Traders

Written for a session that has never seen the conversation that built this. The code is readable;
the reasoning behind it is not, and that is what this file is for. Maintained per
[CLAUDE.md](../CLAUDE.md) "Session management & memory".

Updated: 2026-09-16, after 23 merged PRs, before Milestone 4.

**One-line state:** the product imports a portfolio, fetches six months of real daily prices,
scans it every 30 minutes for four kinds of finding, explains each one in sentences whose every
figure is checked against the evidence, and shows them in a dashboard with the numbers underneath.
It does not yet reach the user — nothing is pushed, nothing is approved.

---

## Milestone status

| Milestone | Status | Notes |
|---|---|---|
| **M0 — Repo skeleton & contracts** | ✅ Complete | monorepo, compose stack, CI, OpenAPI contract + generated client |
| **M1 — Vertical slice** | ✅ Complete | portfolio in, valued portfolio out |
| **M1.5 — Trustworthy quote path** | ✅ Complete | **unplanned**; inserted after an audit found data problems M2 would have built on |
| **M2 — Analysis engine & observations** | ✅ Complete | PRs #12–#22 |
| **M2.5 — Real price history** | ✅ Complete | **unplanned**; PR #23. Finished M1's provider layer, 18 PRs late |
| **M3 — RAG & educational engine** | Not started | gives the feed's concept chips somewhere to point |
| **M4 — Scheduling, HITL & Telegram** | ⏭️ Next | Mastra lands here; the scheduling half is already done |
| M5 — Market discovery & topics | Not started | |
| M6 — Frontend completion & polish | Not started | |
| M7 — Kubernetes & documentation | Not started | |

**Why the two unplanned milestones exist, and the pattern behind them.** Both were gaps the plan did
not anticipate, found by running the thing rather than by reading it. M1.5 came from auditing the
quote path and finding timestamps that made the price series unusable. M2.5 came from asking "can I
get real data out of this?" and discovering the answer was no. Expect more of these: the milestone
plan describes features, and the gaps have all been in the layers underneath them.

---

## Orientation: running and verifying

```bash
bash scripts/dev-docker.sh          # everything in containers; prints URLs and the passphrase
bash scripts/dev-local.sh           # app processes native, Postgres+Redis in containers
bash scripts/smoke-test.sh          # end-to-end against a running stack
```

Full gate, which every PR must pass:

```bash
pnpm -r typecheck && pnpm -r test
cd services/ai && .venv/bin/python -m pytest -q
.venv/bin/ruff check . && .venv/bin/ruff format --check .
```

Test counts at handoff: **551** — 416 Python, 80 orchestrator, 39 web, 16 shared.

Useful endpoints (all need the session cookie except `/internal/*`, which needs `x-internal-key`):

| | |
|---|---|
| `POST /internal/runs` | `{kind: snapshot \| portfolio_scan \| backfill}` — the single entrypoint for all scheduled work |
| `GET /runs` | run history: *did the work actually happen?* |
| `GET /observations` | the feed, with full evidence |
| `PUT /targets` | set allocation targets (no UI yet) |

---

## What exists, by area

**`services/ai`** (Python, FastAPI) — market data providers behind a chain with caching, rate
limiting and per-provider daily budgets; four deterministic analysis rules; news ingestion with
entity extraction; an LLM provider factory with a daily spend guard; narration behind an evidence
validator; the Alembic schema (5 migrations) that both services share.

**`apps/orchestrator`** (Node, Hono) — sessions, holdings CRUD, CSV/JSON import with per-row
validation, valuation with FX, target weights, the scan workflow, run claims, the observations feed,
and the local scheduler.

**`apps/web`** (React, MobX, Tailwind, Recharts) — login, portfolio dashboard, import wizard,
observations feed with an evidence drawer.

**`packages/shared`** — wire types, money helpers, and the AI-service client whose zod schemas are
pinned to the generated OpenAPI types so Python drift becomes a compile error. That mechanism has
caught four real mismatches; trust it.

---

## Decisions that were argued, not obvious

The code shows *what*; these are the *why*. Several look like over-engineering until you know the
failure they prevent.

1. **No market-status API on the pricing path.** Evaluated and rejected. The quota saving is near
   zero because fetching is demand-driven; an external check cannot replace the offline calendar it
   would need as an outage fallback, so you maintain both and the fallback rots; and a wrongly
   cached "market closed" halts pricing for a day — failing in the expensive direction where the
   current design fails in the cheap one. If scheduled scans ever make holidays material, the answer
   is a **static calendar applied at the scheduler**, not a network call per quote.

2. **Partial snapshots are stored and marked, not refused.** A day where 9 of 10 holdings priced is
   recorded with `degraded`, `priced_count` and `holdings_count`. Refusing would leave a silent hole
   in the equity curve, which is just as misleading as an understated total. Rows predating the
   columns are backfilled `degraded = true`: unknown provenance is closer to degraded than to
   trustworthy.

3. **Identity is decided before narration, not after.** The caller sends the dedupe keys it already
   holds and the pipeline skips those before calling a model. Narrating and then discarding on
   insert was ~370 throwaway completions a day at a 30-minute cadence. A repeat costs a hash.

4. **A price series is never stitched across providers.** The chain takes the first provider with
   *any* history rather than merging partial answers, because a daily return measured across the
   seam compares two definitions of a close rather than a move. (Quotes *are* merged across
   providers — different question, no continuity to break.)

5. **`auto_adjust=False` on the Yahoo history read.** An adjusted series rewrites history after
   every dividend and split, so yesterday's closing price would change under us — and an observation
   citing a price the user can no longer find is worse than no observation.

6. **The run-key bucket decides what counts as a repeat, and lives server-side.** `snapshot` and
   `backfill` bucket by day, `portfolio_scan` by half hour. The policy is in `/internal/runs` rather
   than in the caller so a Kubernetes CronJob inherits it unchanged. The timers deliberately fire
   *more often* than the work is allowed to happen (15 min against a 30-min bucket): a timer firing
   exactly once per period skips that period entirely if the process restarts at the wrong moment,
   and a silently skipped run looks exactly like a quiet market.

7. **pgvector inside Postgres**, not a separate vector database, behind a `VectorStore` interface.
   One fewer container, transactional writes with the rest of the domain.

8. **REST + OpenAPI, not gRPC**, with routes shaped so SSE can be added without changing payloads.

9. **One trigger path for scheduled work.** Locally a timer calls `POST /internal/runs`; in
   Kubernetes a CronJob will, with `SCHEDULER_ENABLED=false` on the Deployment. Two schedulers would
   double-fire.

10. **Cost basis is stored per unit, not as a position total.** Editing quantity would otherwise
    leave a total nobody paid, and the system could not tell a correction from a purchase.

11. **Mastra is deferred to M4** — see `apps/orchestrator/src/mastra/README.md` for the seams it
    will use. A workflow engine with no observations to act on could not have been tested.

12. **Session auth is a signed self-describing cookie**, no session table. Only `http/auth.ts` and
    the login route change when real multi-user auth arrives.

13. **Misconfiguration fails at boot in production, degrades in development.** An unknown LLM
    provider or a missing key raises in production and returns a null provider elsewhere.
    `LLM_PROVIDER=null` is always honoured: the distinction that matters is *deliberately off* versus
    *broken*.

14. **Unpriced is `null`, never `0`.** A zero is indistinguishable from a real value, so an
    infrastructure failure would render as a financial fact. The same argument rejects a `1.0` FX
    fallback: it collides with the legitimate same-currency rate, destroying the evidence that
    anything went wrong.

15. **The milestone order was changed from the original brief** to ship a vertical slice first.

---

## Bugs that cost real time, and the lesson from each

These are listed because the lesson generalises, not because the bug was interesting.

**Stacked PRs silently lost merged work.** #8 and #9 were merged into their *base branches*, which
had already been merged into main — so GitHub showed them MERGED while their code was nowhere. Two
PRs of work, including the rate-limiter fix, sat orphaned until a content check found them.
→ **One branch off `main` at a time. After merging, verify by content (`grep` for a marker), never
by the merge badge.** Parallel authoring in worktrees is fine; parallel *merging* is not.

**Tests that read `.env` pass on the wrong machine.** A test asserting `/market/*` rejects
unauthenticated requests passed locally (where a real key was set) and failed in CI (where the
default key triggered a bypass) — and the *green* result was the misleading one, because it was
green for a reason unrelated to the code. The same pattern recurred twice more.
→ **Build settings with `_env_file=None`; override injected config.** A test whose result depends on
a file outside the repository is testing the machine.

**Tests pinning tuning values fail for unrelated reasons.** A daylight-saving test asserted the
crypto TTL was 60; raising that TTL broke a test about session boundaries. Three separate spurious
failures came from this.
→ **Assert constants, never their current values.** A test should fail when the behaviour it
describes changes, and at no other time.

**Templates tested against invented evidence.** The drawdown template read `peak_price_minor` while
the rule emits `high_price_minor`. Every unit test passed because every unit test supplied evidence
written by hand; the first real scan raised `KeyError`. The same shape hid a worse one: allocation
drift requires each position to carry the observation time behind its value, and neither the
pipeline nor its test supplied one — **drift could never have fired in production, silently**.
→ **Test the consumer against output the producer actually generates**, not against a fixture of
what you believe it generates.

**A wildcard auth guard shadowed the internal routes.** Mounting the session check as a sub-router
at `/*` made `POST /internal/runs` return 401 to everyone, including the cron trigger. The symptom
would have been *silence* — no alerts, no observations, a dashboard that looks perfectly healthy —
and liveness probes cannot see it, because the process is fine and its dependencies are fine.
→ **Scheduled work needs a freshness check** ("did anything run today?"), not a liveness probe.
`GET /runs` exists for this.

**A fixture that looked like a solved problem.** The synthetic price history made the analysis
engine testable and also let the missing `history()` survive two milestones. A fixture hides an
absence.
→ When a fixture stands in for a real source, **record what is still missing** rather than treating
the green test as coverage.

---

## Current technical debt

| Item | Where | Impact |
|---|---|---|
| **Explanation provenance is not stored** | `observations` | Nothing records whether a sentence came from the model or a template, so the UI cannot show it and a reader cannot weigh it. Needs a column; the pipeline already computes `narration_source` and `fallback_reason` and throws them away on insert |
| **Concept chips point nowhere** | `apps/web` | PRD FR-16 wants one click to an explanation; the corpus arrives in M3. They render as labels rather than dead links |
| **Target weights have an API and no UI** | `apps/web` | `PUT /targets` is tested and works; setting them requires curl. Allocation drift is invisible to a user who does not know the endpoint exists |
| **Import previews live in process memory** | `services/previewStore.ts` | Forces `replicas: 1` in Kubernetes. The only remaining in-memory state — run keys moved to the `runs` table in M2 |
| **Narration runs on a free, shared OpenRouter route** | `.env`, `app/llm` | The paid budget is spent, so `LLM_MODEL` is a `:free` route. Free routes are a shared pool: `429 overloaded` is normal under load and shows up as a template fallback, so narration coverage is now weather rather than a guarantee. Quality is a small open model's, not Sonnet's. Both are fixed by pointing `LLM_MODEL` at a paid model and funding the workspace |
| Crypto detection is a symbol-shape heuristic | `core/cache_policy.py` | `-USD` suffix, because the AI service receives bare symbols |
| Market hours assume US sessions for every symbol | `core/cache_policy.py` | SAP.DE trades on XETRA but is judged against NYSE hours. The same wire change (pass `asset_class` and `exchange` on the quote request) fixes both this and the heuristic above |
| No component/DOM tests on the web app | `apps/web/test` | Store and formatting logic covered; rendering is not |
| Redis cold start refetches everything | `core/cache.py` | The `quotes` table holds usable recent prices; warming from it was deferred |
| `instruments`, `quotes` and the news tables have no `user_id` | migrations | **Intentional** — shared reference and market data, not user-owned. Documented so an audit does not re-flag it |

---

## Local environment (this machine)

- **`.env` has `MARKET_DATA_PROVIDERS=yfinance,fixture`** — real, 15-minute-delayed prices.
  **`.env.example` keeps `fixture,yfinance`** so a fresh clone and CI run entirely offline with no
  API keys. Do not "fix" the difference: it is the point.
- Other processes on this machine hold ports 5432, `127.0.0.1:8000` and `[::1]:5173`/`[::1]:5174`.
  Every published port is configurable; this machine uses `POSTGRES_HOST_PORT=55432`,
  `WEB_HOST_PORT=5174`, `AI_SERVICE_HOST_PORT=8001`.
- **Reach the dashboard at `http://127.0.0.1:5174`, not `localhost`** — macOS resolves `localhost`
  to IPv6 first, where a different project is listening.
- The database currently holds ~1,800 real daily closes from Yahoo and a real portfolio scan's
  observations. Nothing synthetic remains in `quotes`.
- **A git worktree has no Python venv and no `.env`** — both live in the main checkout only, and
  `services/ai`'s editable install points at the main checkout's `app/`, so the obvious
  `.venv/bin/pytest` silently tests the *other* tree. Run a worktree's Python suite as
  `cd services/ai && PYTHONPATH=$PWD /Users/a/projects/Traders/services/ai/.venv/bin/python -m pytest -q`;
  `PYTHONPATH` precedes site-packages, so it wins over the `.pth`. `pnpm install` in the worktree
  does work and is needed once.

---

## Starting M4

The scheduling half of M4 is already done (run kinds, buckets, idempotent claims). What remains is
the human-in-the-loop state machine and Telegram. The seams are in place: `POST /internal/runs` is
the trigger, `runs.run_key` is the idempotency guarantee, `observations.dedupe_key` stops a repeat
notifying twice, `users.quiet_hours` exists, and severity is already on every observation.

**Two things to settle before writing code.** Proposals need a durable state machine with a TTL —
an approval acted on hours later is a decision made against prices that have moved. And a Telegram
callback is replayable: the payload must be signed, single-use and TTL-checked, or a forwarded
message becomes an approval. `docs/FLOWS.md` F3 and F4 have the intended shapes.
