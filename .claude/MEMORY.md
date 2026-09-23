# Project memory — Traders

Written for a session that has never seen the conversation that built this. The code is readable;
the reasoning behind it is not, and that is what this file is for. Maintained per
[CLAUDE.md](../CLAUDE.md) "Session management & memory".

Updated: 2026-09-23, after 37 merged PRs. M4 is complete; M3 has not started. The session that
wrote this shipped the targets UI, unblocked four migrations that could not apply, and made the
narration layer tell the truth about itself.

**One-line state:** the product imports a portfolio, fetches six months of real daily prices, scans
it every 30 minutes for four kinds of finding, explains each one in sentences whose every figure is
checked against the evidence, lets the user **state the allocation they meant to hold**, and turns
the drift from it into a proposal with a deadline that an approval writes to a paper ledger. No
order is ever placed. The explanations are currently written by templates rather than a model, and
the app now says so on its own dashboard.

**What is not proven:** the entire Telegram leg, and this is worse than it was at M4. A webhook
still needs the public HTTPS URL that arrives with M7's ingress — but on top of that, *no chat is
currently bound and nobody has been able to bind one*: the bot our token controls receives nothing
at all, through repeated long polls, for reasons still unexplained (see the debt table). So
proposals reach the notifications ledger, correctly recorded as `failed`, and reach no human.

---

## Milestone status

| Milestone | Status | Notes |
|---|---|---|
| **M0 — Repo skeleton & contracts** | ✅ Complete | monorepo, compose stack, CI, OpenAPI contract + generated client |
| **M1 — Vertical slice** | ✅ Complete | portfolio in, valued portfolio out |
| **M1.5 — Trustworthy quote path** | ✅ Complete | **unplanned**; inserted after an audit found data problems M2 would have built on |
| **M2 — Analysis engine & observations** | ✅ Complete | PRs #12–#22 |
| **M2.5 — Real price history** | ✅ Complete | **unplanned**; PR #23. Finished M1's provider layer, 18 PRs late |
| **M3 — RAG & educational engine** | ⏭️ Next | gives the feed's concept chips somewhere to point; a WIP branch exists, see "Where to go next" |
| **M4 — Scheduling, HITL & Telegram** | ✅ Complete | PRs #26–#33. Mastra adopted for `proposalLifecycle` only |
| M5 — Market discovery & topics | ⏭️ Next, or M3 | independent of each other; see "Where to go next" |
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

Full gate, which every PR must pass. **The compose smoke test is part of it and is easy to skip**
— it is the only gate that starts the services the way they are actually deployed, and in M4 it
caught a config bug that every one of 700 unit tests missed: an optional secret declared
`z.string().min(1).optional()` is fine when the variable is *absent* and refuses to boot when it is
*present and empty*, which is exactly what compose passes through for every key listed in
`.env.example`. If you do not run it locally, read CI before merging rather than after.

In a worktree, see "Local environment" for why the Python line below is not the one to use.

```bash
pnpm -r typecheck && pnpm -r test
cd services/ai && .venv/bin/python -m pytest -q
.venv/bin/ruff check . && .venv/bin/ruff format --check .
```

Test counts at handoff: **886** — 439 Python, 314 orchestrator, 117 web, 16 shared.

Useful endpoints (all need the session cookie except `/internal/*`, which needs `x-internal-key`):

| | |
|---|---|
| `POST /internal/runs` | `{kind: snapshot \| portfolio_scan \| backfill \| proposal_sweep \| daily_digest \| instrument_metadata}` — the single entrypoint for all scheduled work |
| `GET /runs` | run history: *did the work actually happen?* |
| `GET /observations` | the feed, with full evidence |
| `GET /proposals?state=open` | the approvals inbox; `POST /proposals/:id/decision` answers one |
| `GET /notifications` | *what was the user told, and what were they deliberately not told* |
| `GET`/`PUT /settings` | severity floors, TTL, quiet hours, mute |
| `PUT /targets` | set allocation targets; the **Targets page** writes it (#35) |
| `GET /narration` | is a model writing the explanations, and if not, why not (#38) |
| `POST /telegram/bind-token` | the **Settings page** mints the connect link (#38) |
| `POST /telegram/bind-token` | mints the signed connect link; `POST /telegram/webhook` is public |

---

## What exists, by area

**`services/ai`** (Python, FastAPI) — market data providers behind a chain with caching, rate
limiting and per-provider daily budgets; four deterministic analysis rules; news ingestion with
entity extraction; an LLM provider factory with a daily spend guard; narration behind an evidence
validator; the Alembic schema (5 migrations) that both services share.

**`apps/orchestrator`** (Node, Hono) — sessions, holdings CRUD, CSV/JSON import with per-row
validation, valuation with FX, target weights, the scan workflow, run claims, the observations feed,
the local scheduler, **the proposal state machine and its audit trail, the notification fan-out, the
Telegram adapter, and per-user settings**.

**`apps/web`** (React, MobX, Tailwind, Recharts) — login, portfolio dashboard, import wizard,
observations feed with an evidence drawer, **the approvals inbox and a settings page**.

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

11. **Mastra is adopted for `proposalLifecycle` only** — and this **diverges from MILESTONES.md
    M4**, which lists four workflows (`portfolioScan`, `topicScan`, `dailyDigest`,
    `proposalLifecycle`). The scheduling half already works: run kinds, run keys, the half-hour
    bucket and the claim in the `runs` table. Porting it would buy a different spelling of the
    same behaviour and risk a regression in the one subsystem whose failure mode is *silence* —
    and Mastra's scheduler would want to own the trigger, while DESIGN.md §2 has exactly one
    (`POST /internal/runs`) precisely so a CronJob and a local timer cannot both fire. What the
    existing scheduler genuinely cannot express is a **suspension**: a run that pauses for hours
    waiting on a person and is still there after a restart. That is the whole reason the
    dependency earns its place, and it is the only thing it is used for. If a later milestone
    wants `dailyDigest` as a workflow, the argument to re-examine is that one, not this
    precedent.

    Two rules keep the adoption from rotting, both stated in
    `apps/orchestrator/src/mastra/README.md`: **nothing under `mastra/` decides anything** (every
    transition goes through `applyDecision`, or F3's invariants stop being properties of the
    system), and **every entry point degrades to the service when the runtime is absent** — a
    coordinator that can block a decision the user made would be worse than no coordinator.

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

16. **A proposal's expiry is computed on every read, never trusted from the row.** `effectiveState`
    recomputes it, and the stored value is a cache. Trusting the column would leave a window between
    a deadline passing and the sweep noticing in which a dead proposal is still answerable — and
    that window widens to the whole sweep interval after a restart, which is exactly when a user is
    most likely to be retrying something. The sweep is therefore *housekeeping*, not correctness: it
    exists so the inbox can filter on a column and the audit trail can say when each proposal died.

17. **Idempotency is an outcome, not an exception.** A decision returns `applied`, `unchanged` or
    `refused`. `unchanged` is a **success**: it means the proposal was already in the state asked
    for, which is what a second tap produces — usually because the first reply was lost, and that
    user did nothing wrong. Collapsing it into an error punishes them; collapsing it into `applied`
    writes a second audit row and a second ledger entry for one act.

18. **Nothing is ever dropped on the notification path.** Quiet hours, a severity floor and an
    explicit mute all change *when* the user hears, never *whether* — everything suppressed is
    deferred into the digest. A notification that vanishes is indistinguishable from a market that
    did nothing. For the same reason `notifications` is a **ledger, not a queue**: a suppressed
    message gets a row with its reason, so "we chose not to tell you" and "we failed to tell you"
    can never look the same afterwards. That is the question actually asked after an incident.

19. **Claim, then send, then settle.** The `notifications` insert *is* the claim (`dedupe_key` is
    unique). Sending first and recording after is the obvious alternative and it is wrong: a crash
    between them loses the record of a message the user has already read, and the retry sends it
    again. Claiming first fails the other way — a `pending` row for a message that never went out,
    which the digest picks up. **A missing alert is recoverable; a duplicated one is not.**

20. **Two Telegram secrets, and only one of them ever signs anything.**
    `TELEGRAM_WEBHOOK_SECRET` answers "is this really Telegram?" and nothing else: Telegram holds a
    copy, it rides in every inbound header, and it is plaintext wherever TLS terminates.
    `TELEGRAM_SIGNING_SECRET` signs the inline buttons and the connect links and never leaves the
    process. The first implementation signed connect links with the *webhook* secret, which was a
    real hole — `SINGLE_USER_ID` defaults to a value published in this repository, so anyone who
    read that header out of a proxy log could mint a link, bind their own chat and approve
    proposals. Both token types are signed over a domain tag so one key cannot mint the other kind.

21. **Reasoning effort is a property of the task, not of the installation.** It was one
    process-wide setting baked into the provider at construction. Narration has no judgement to
    improve — it restates figures it may not alter, and the evidence validator is what makes the
    sentence trustworthy — so it wants thinking off; `/ask` deciding whether its retrieved context
    supports an answer at all genuinely wants it on. One setting forces one answer on both, and the
    caller that never considered it silently inherits the choice made by the one that did. So it is
    a per-call argument: `None` means "no opinion, use the deployment default", the string `"none"`
    is an opinion and overrules it, and the two are deliberately not collapsed.

22. **The evidence validator is not made redundant by a better model.** It was asked directly, and
    the answer matters: a capable model changes the *rate* of unsourced figures, never the
    possibility, and guideline 7 is categorical. Better models also fail more dangerously — a weak
    model's invention is clumsy, a strong one's is plausible and stylistically identical to the true
    sentences around it. The validator is also what makes the evidence drawer an actual check rather
    than decoration, and it is the detector that makes the template fallback possible at all: you
    cannot degrade from a bad narration you cannot identify. It costs nothing, and its rejection
    rate doubles as a measurement of whether a model is fit for the job — which is how we learned
    the free one is not, without shipping a single bad sentence.

23. **The acting user comes from the chat binding, never from the callback payload.** There is
    nowhere in a forged token to name a victim. A forwarded Telegram message keeps working buttons,
    so this is the property that makes forwarding harmless.

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

**Three M4 bugs were found by *using* the product, and none had a failing test.** This is the most
generalisable thing learned in M4, so it is stated as a group rather than three entries.

- Tapping Approve on a real bot did nothing visible. `answerCallbackQuery` is a toast that fades and
  leaves no trace, and FLOWS.md F4's "edit the message" step had simply not been implemented. Every
  test asserted the toast, because the toast was what had been built.
- A test pinned `NOW` to a fixed date and then called the service *without passing that clock*, so
  it compared a frozen fixture against the real one. It passed in CI and began failing permanently
  a few hours later, on `main`, once wall-clock time crossed the fixture's value.
- Two secrets were documented as separate precisely so a leak of the shared one could not forge what
  the private one protects — and the code then signed connect links with the shared one. The
  comment was accurate about the intent and wrong about the implementation.

→ **A test written after the code tests what was built, not what was specified.** All three survived
a full green gate. Re-read the spec against the code, and use the thing; the second found two of
these and a direct question from the user found the third.
→ Specifically: **`now` is an argument, everywhere, and every call must actually pass it.** One call
site in a file already did, which is what made four omissions easy to miss.

**A migration rewrote an enumeration by retyping it, and dropped a value.** 0006 rebuilt
`runs_kind_check` from a hand-typed list that omitted `backfill` — the kind 0005 exists entirely to
add. Every database holding a backfill run refused 0006 and stopped at 0005, taking 0007–0009 with
it: the entire M4 schema unreachable. This machine sat like that for days, which is why `proposals`
and `notifications` did not exist locally and nothing downstream of an observation was ever visible.
The fix had to be *in 0006*, because a repair migration is never reached — the failure happens
inside the file that refuses to apply.
→ **Extend a named list; never retype the literal.** And the deeper one:
→ **A CHECK constraint is only exercised by data.** CI migrates an empty database, so it proves the
SQL parses and nothing more. The constraint that matters is the one applied to rows that already
exist — the case CI never has and every real installation does.
`services/ai/tests/test_run_kinds_contract.py` now asserts both properties and reads both lists from
source. It was confirmed to fail against the original bug before being kept.

**A reasoning model's thinking is billed out of the answer's token budget.** Narration on a `:free`
route returned the model's chain of thought instead of JSON, which looked like a model ignoring
instructions. It was truncation: 1707 reasoning tokens against a 700-token ceiling, and a reply cut
off mid-thought comes back with the reasoning in `content`. `{"exclude": true}` does not help — it
hides the reasoning and still spends it. Only turning thinking off does.
→ **Reasoning earns its tokens when the answer is not determined by the input.** Narration restates
figures under rules and has no judgement to improve; `/ask` deciding whether to refuse does. That is
why `reasoning_effort` is now a per-call argument rather than one process-wide setting — otherwise
the caller that never thought about it inherits the choice made by the one that did.

**Two changes were written against wrong diagnoses and deleted.** A JSON parser made tolerant of a
reasoning preamble rescued none of the real replies, and an `{"enabled": false}` special case
measured identical to the pass-through it duplicated.
→ **Code written for a cause that turned out to be imaginary does not earn its place by being
harmless.** Delete it and keep the measurement.

**Verification methods failed three times this session, and each time looked like working code.**
A `grep -c "Done"` hid a failing typecheck. Container-based checks of worktree code tested `main`,
because compose builds from the main checkout. Browser clicks "succeeded" against an unfocused tab
while screenshots looked fine, so the page appeared broken when it was not.
→ **Read the output of a gate; never count its matches.** And when a check passes or fails
surprisingly, suspect the harness before the code.

**A PR merged while its fix was still being written.** The message-edit fix was pushed to
`feat/telegram` after #30 had already merged, so it went nowhere and needed its own PR.
→ **Once a PR is merged, its branch is dead.** A follow-up starts from `main`.

**A migration number is a shared resource.** Two PRs in flight both took `0007` off `0006`, which
would have given Alembic two heads and broken `upgrade head` outright. Neither PR could see the
other.
→ **Check `alembic heads` returns exactly one before merging anything with a migration**, and
renumber the PR that is cheaper to move — the one not yet opened, not the one already in review.

**A fixture that looked like a solved problem.** The synthetic price history made the analysis
engine testable and also let the missing `history()` survive two milestones. A fixture hides an
absence.
→ When a fixture stands in for a real source, **record what is still missing** rather than treating
the green test as coverage.

---

## Current technical debt

| Item | Where | Impact |
|---|---|---|
| **Telegram's inbound delivery is unproven** | deployment | Everything else was exercised against a real bot, but `setWebhook` needs a public HTTPS URL. The handler has only ever been driven by replaying genuine payloads at it locally. **The first real deployment is the first real test of that leg** — check `getWebhookInfo` for `last_error_message` immediately after |
| **`queries.ts` conflicts on every parallel PR** | `src/db/queries.ts` | Four M4 PRs appended a section to the end of one 1,200-line file, and every rebase put a conflict marker exactly where one function's closing brace met the next block's header — the brace was lost and hand-repaired **three separate times**. It is the cost of CLAUDE.md's "all SQL in one file" rule, which is otherwise good. Worth deciding whether to split by domain with an index |
| **Migration 0008 hard-codes a table Mastra owns** | `0008_mastra_workflow_state.py` | The library would create `mastra_workflow_snapshot` itself; Alembic creates it instead (`disableInit: true`), because CLAUDE.md says the AI service owns the schema. An upgrade that changes the shape breaks suspended runs — so `test/mastraSchemaOwnership.test.ts` compares the migration against `WorkflowsPG.getExportDDL()` and fails the build first. Two other things cost time to find: `PostgresStore` creates **43** tables for 24 storage domains unless you route only `workflows`, and `@mastra/core` posts feature-usage telemetry to PostHog unless `MASTRA_TELEMETRY_DISABLED` is set (it is, in `workflowRuntime.ts`, in code rather than `.env`) |
| **Concept chips point nowhere** | `apps/web` | PRD FR-16 wants one click to an explanation; the corpus arrives in M3. They render as labels rather than dead links |
| **Import previews live in process memory** | `services/previewStore.ts` | Forces `replicas: 1` in Kubernetes. The only remaining in-memory state — run keys moved to the `runs` table in M2 |
| **Templates are the deliberate steady state until deployment** (decided 2026-09-23) — funding narration was considered and **declined for now**, to be revisited when the product is deployed for real. So a future session should *not* treat template-only explanations as a defect to fix: the cost is known ($0.45/month), the fix is known (raise the OpenRouter workspace cap, point `LLM_MODEL` at a capable model), and the decision is to wait. | `.env` | Explanations are fixed phrasing over checked figures, and the dashboard badge says so |
| **The free tier cannot narrate at all, and the reason is not cost** | `.env`, `app/llm` | `LLM_MODEL` is a `:free` route because the OpenRouter workspace has a **lifetime** budget of $0.01 — a cumulative cap, not an allowance, so nothing resets and only an org admin changes it. On the free model narration now reaches the evidence validator and is **rejected every time** (`unsourced_figures`, 3/3 measured) for deriving figures not in the evidence. So free means templates, reliably. Real usage is ~$0.0015 per narration and ~10 findings a day ≈ **$0.45/month**, which is what funding the workspace costs. The badge (#38) states this to the user rather than hiding it |
| Crypto detection is a symbol-shape heuristic | `core/cache_policy.py` | `-USD` suffix, because the AI service receives bare symbols |
| Market hours assume US sessions for every symbol | `core/cache_policy.py` | SAP.DE trades on XETRA but is judged against NYSE hours. The same wire change (pass `asset_class` and `exchange` on the quote request) fixes both this and the heuristic above |
| No component/DOM tests on the web app | `apps/web/test` | Store and formatting logic covered; rendering is not. Two real UI bugs this session (Discard disabled by its own typo, a deep link that does nothing) were found by *using* the app, not by tests, and neither would have been caught by a DOM test either — but a DOM test would have caught the first |
| **Telegram has no working binding, and why is unresolved** | deployment, `.env` | The bot our token controls (`@trade_pulse_agent_bot`, id `8840824780`) receives **nothing**: three 50-second long polls while the user was actively sending, `pending_update_count: 0`, no webhook, `getMe` fine. An unrelated OpenClaw gateway runs on this machine bound to a *different* bot (`8778977785`), so it is not the consumer. Next test: search `@trade_pulse_agent_bot` in Telegram and see whether it opens a fresh chat or the existing one — the chat may belong to another bot with the same display name. **Until this is settled the whole delivery leg is unproven**, and the notification on narration state change was deliberately left unbuilt rather than verified only to the ledger |
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
- **Every worktree shares one development database.** A background task's migration lands in the
  same Postgres the main stack uses, so the database can end up *ahead* of the running containers.
  That is how an "impossible" `Can't locate revision` appeared: the DB was at `0010_instrument_metadata`
  while the images still held 0009.
- **`docker compose` builds from the main checkout, never from a worktree.** `REPO_ROOT` resolves to
  the script's own repo and the compose context is `/Users/a/projects/Traders`, so rebuilding while
  working in a worktree silently tests `main`. Several "fix confirmed" results this session were
  actually confirming unmodified code. To exercise a branch end to end, run the three processes from
  the worktree instead — AI service on `:8002`, orchestrator on `:8081` (`ORCHESTRATOR_PORT`, not
  `PORT`), web dev server on `:5179` with `VITE_API_BASE_URL` pointing at the orchestrator, and
  `ALLOWED_ORIGINS` set to that web origin or CORS refuses every state-changing request.
- **The main checkout is not pulled automatically.** It sat on `a0637be` for three merged PRs, which
  is what made the compose images stale. Pull it before rebuilding anything.
- **An `ai.openclaw.gateway` LaunchAgent runs permanently on this machine** with a Telegram connector
  bound to bot `8778977785` — *not* ours. It is unrelated, and it is recorded here so the next
  session does not spend an hour suspecting it of eating updates, as this one did.
- **A real Telegram bot is configured**: `@trade_pulse_agent_bot`. `.env` holds its token, its
  username and the two secrets. The bot is live — anyone with that token controls it; `/revoke` in
  BotFather if it ever leaks.
- **No webhook is registered**, so `getUpdates` polling works for local testing and is how M4 was
  verified. Registering one disables polling. To drive the real handler locally without a public
  URL: poll `getUpdates`, then POST each update to `/telegram/webhook` with the
  `x-telegram-bot-api-secret-token` header. That bridge is how approve/reject/snooze were tested.
- **The chat binding from that testing is gone** — it lived in a scratch database that was dropped.
  The connect flow has to be redone against whatever database is actually used.
- Telegram hides a deep link's `?start=` payload in the message bubble: the chat shows a bare
  `/start` while the update carries the token. Do not conclude from the UI that the payload was lost.

---

## Where to go next

**The targets UI is done (#35), so the M4 path now carries something real.** Verified end to end on
this machine: targets set in the UI produced four drift findings, three of them became `pending`
`rebalance` proposals with 24-hour deadlines, and the notification ledger recorded three
`above_floor` attempts plus one `below_floor` deferral into the digest. That chain is no longer an
argument, it is an observation.

**M3 (RAG) is next.** The feed's concept chips have rendered as dead labels since M2, it is the last
piece of the "explain it to me" promise in the PRD, and it is independent of everything M4 touched.
M5 (topics) remains the larger change: it widens `notifications.ref_kind` and wants topic-shaped
proposals.

### Picking up the parked M3 branch

`claude/m3-corpus-concept-links` holds one WIP commit: the corpus schema and three of the nine
concept documents. **Renumber its migration before anything else** — the commit still carries
`0010_kb_corpus.py`, and both `0010` (instrument metadata) and `0011` (narration provenance) are
taken on `main`, so it must become `0012` with `down_revision = "0011_narration_provenance"`. Check
`alembic heads` returns exactly one before merging anything with a migration.

The nine slugs the corpus has to cover, hard-coded in `app/narration/templates.py`, are
`daily-return`, `standard-deviation`, `z-score`, `volatility`, `drawdown`, `peak-to-trough`,
`asset-allocation`, `rebalancing`, `portfolio-weight`. Covering exactly those satisfies FR-16 and
half the milestone's exit criterion.

The sliced plan that branch was following: **(1)** corpus, schema and live concept links, with no
embeddings at all — a `vector(n)` column is a commitment to a model and `n` should be chosen on
evidence; **(2)** `VectorStore`, an embeddings provider and hybrid retrieval, with a deterministic
fixture embedder so CI stays hermetic and keyless; **(3)** `POST /ask` with intent routing,
citations and a relevance floor; **(4)** the ~30 Q/A eval set in CI. pgvector 0.8.6 is already
installed in the database — M0 planned for it.

**The embeddings provider is an open decision** and shapes step 2: fund a paid embeddings model, run
a local one in-container, or ship only a fixture embedder and accept that retrieval quality is a
placeholder. See the free-tier debt row for what funding actually costs.

### Left unfinished, deliberately

The **notification on narration state change** (working → failing, or back, deduped so it fires on a
transition rather than every thirty minutes) was designed and not built. It needs a bound Telegram
chat to be verified against, and there is not one — see the debt table. Building it would have meant
verifying only to the ledger and calling that done, which is the exact mistake M4's lessons warn
about.

Whichever is next, the seams M4 leaves are: `notifications.ref_kind` already anticipates a third
referent, `Notifier` takes another channel without touching the fan-out, and `PROPOSABLE_KINDS` in
`services/proposals.ts` is the entire policy for what becomes a question — one map, deliberately
short, and the place to argue about before adding to it.

**Before the first real deployment**, read decision 20 and set `TELEGRAM_SIGNING_SECRET` to a value
that is not the webhook secret. An unset signing secret degrades to a null notifier with a stated
reason rather than booting broken, so the mistake is visible — but a *shared* value would not be.
