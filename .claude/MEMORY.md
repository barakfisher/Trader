# Project memory — Traders

Written for a session that has never seen the conversation that built this. The code is readable;
the reasoning behind it is not, and that is what this file is for. Maintained per
[CLAUDE.md](../CLAUDE.md) "Session management & memory".

Updated: 2026-09-30 ~09:30 UTC - **M6 handoff at CLAUDE.md's five-merged-PR trigger (#98-#102).
M6 is in progress; PR 11 (the feed) was then done in the same session at the user's request, then PR 12 (mobile) as well, so the next session starts PR 13, times and disclaimers** - see "Next session: M6,
continued" in "Where to go next". This session:
- #98: **the backfill stored a day still trading as its close**, permanently (`DO NOTHING`) - found
  measuring history for the holding page; a manual run corrected 18 rows (AAPL 16 Sep to $332.41);
- #99 (decision 68): per-holding page `/holdings/$holdingId` - a chart of the rules' own series
  (a new AI-service endpoint), position, findings, news;
- #100 (decision 69): the proposals inbox - readable evidence, a history with expiries (dated by
  deadline: the sweep recorded them a median 52 h late), `/proposals/$proposalId`, optional
  `WEB_BASE_URL` for a Telegram "Open in app" link;
- #101: **a looping model answer passed the evidence validator** - found measuring `/ask`;
- #102 (decision 70): the `/ask` screen; queue task 6 closed, **the independent-tasks queue is empty**.
The user gave this session standing permission to merge each PR once CI was green, rebuild the
stack, and check each screen in the in-app browser, **not** to click Approve/Reject/Snooze or save
settings. **Ask again** - permissions do not carry over.

Previous handoff, 2026-09-30 ~07:00 UTC - **M6 mid-milestone handoff, at the user's request (context full).
M6 is in progress: 9 PRs merged (#88-#96); the next session starts PR 8, per-holding detail** - see
"Next session: M6, continued" in "Where to go next". The five-merged-PR trigger fired at #92; the
user asked to continue to the milestone's end, then chose to hand off here. This session:
- measured the running app at 1280 and 375 px before building (the plan in "Next session" came
  from that), and agreed the M6 order with the user: **TanStack Query first**;
- #88: dashboard fixes found by looking - a donut blank on every return, a header that scrolled
  away, "-15.5% below";
- #89 (decision 63): **the evidence validator approved cents written as dollars** ("fell to
  4016") - 4 of 11 stored model narrations; the 4 were rewritten by templates;
- #90-#93 (decisions 64): **all server state in TanStack Query**; queue task 7 closed;
- #94 (decision 65): every view has an address (TanStack Router, code routes);
- #95 (decision 66): the equity curve, stored snapshots only - and a DATE printed through
  `toISOString()` that made every snapshot a day early east of UTC;
- #96 (decision 67): **fixture prices had been standing in for real ones** in this installation's
  chain and produced a false high finding ("NVDA -48.6%"), which the user had deleted.
Merging, rebuilding and deciding were delegated by the user for M6 in this session; **ask again**.

Previous handoff, 2026-09-29 ~13:40 UTC - **M5's closing handoff (milestone boundary). M5 is complete;
the next session starts M6** - see "Next session: M6, continued" in "Where to go next". This session:
- designed the broader news feed with the user, every one of six decisions measured read-only on
  raw GDELT files first (three 24 h samples, then all 672 slots of 2026-09-22..29);
- #83: discovery indexed (69 s -> 2.8 s on a real week, identical output) - it would have timed
  out at the orchestrator's 30 s on the market feed's first full week;
- #84: the market feed (decision 60) - same GDELT files, second filter, `articles.feed`;
- #85: one foreign country's press is local news (decision 61) - `data/outlets`;
- #86: weak proposals in their own band and cap, behind a toggle (decision 62).
**M5's exit, shown on live data 2026-09-29:** discovery proposed "data center" (DLR, APLD, CIFR,
GDS, CORZ, KEEL, BXDC) and "bond yields" from real stored headlines; "canadian imports" was
rejected in the UI and the next run (`topic_discovery:manual:rejection-check-1790688549`) said
*matches rejected topic "canadian imports" by words*. The free-text half (resolve -> confirm ->
topic observations) was shown in #53-#57. The user asked this session's Claude to merge each PR
once CI was green and rebuild the stack, and it did; **Option B** (Claude rejecting a proposal
through the UI) was chosen by the user for the rejection check - ask again next time.

Previous handoff, 2026-09-29 ~08:30 UTC (at a natural boundary, at the user's request: three PRs
merged, #79-#81). **The next session starts with the design of a broader news feed** - see
"Next session" in "Where to go next". This session worked M5's exit proof and found that the
feed, not discovery, is what stands between it and a real theme:
- #79: wordings of one story are one candidate (`VARIANT_SHARE`, decision 55) - one Nvidia
  launch had spent 7 of 8 resolve slots;
- #80: one company's news is not a theme (decision 59): a phrase at 0.75+ of one followed
  instrument's headlines is dropped with its reason; `PHRASES_REQUESTED` 20 -> 100;
- #81: `face`, `ceo`, `keep` are generic words.
The manual run after #80 dropped 82 of 100 phrases as one company's news and resolved 8 that
were not themes ("short interest", "jim cramer"...). Every PR was measured read-only against the
stored headlines before it was built, at the user's request - keep doing that.

Previous handoff, 2026-09-29 05:30 UTC (at CLAUDE.md's five-merged-PR trigger: #73-#77): **the
next session starts with M5's exit proof, which is now due** - see "Next session" in "Where to go
next" - and then the two queue tasks left (6 and 7, both M6-sized). This session took tasks 1-5
of the "Independent tasks queue", one PR each, all merged and the stack rebuilt:
- #73: money at the currency's exponent - in the templates *and* the evidence validator, which
  had approved the same hundredfold-wrong yen figure;
- #74: a Telegram notice when explanations switch between the model and templates (decision 58),
  verified with a real message the user received;
- #75: the Topics page looked at in a browser; two phone-width faults fixed (the dashboard header
  made the page 721 px wide and sent a tap on "Topics" to Settings);
- #76: **the `postgres (integration)` CI job** - migrations round-tripped over data covering every
  enumerated value, retrieval/topic SQL, `queries.ts`. Its first run found that 0019 could not
  follow its own downgrade (fixed in 0019);
- #77: quotes carry each instrument's asset class and exchange (`market_sessions.py`).

Merging: the user asked this session's Claude to merge its PRs once CI was green, and it did.
Replies pasted as quoted text were confirmed with the user before being acted on, at their
choice each time ("just this once") - keep asking.

Second handoff of 2026-09-28 (after #71): #71 made unanswered auto-proposals expire (decision
57), and #72 created the queue.

Earlier the same day (handoff at CLAUDE.md's five-merged-PR trigger: #62-#66 merged since the
last one): **M5 is feature-complete and its exit criterion is not yet shown.** Topic resolution,
confirmation, topic observations, topic news, per-topic sentiment, the digest's topic section,
auto-discovery with rejection memory (decisions 55-56) and topic cards are all built and live.
**What is missing is evidence:** auto-discovery has never been seen proposing a real theme, and
M5's exit criterion needs one. It needs 24-48 hours of title-matched headlines first (the user's
call, 2026-09-28) - see "Next session" in "Where to go next". This session shipped:
- #62: auto-discovery with rejection memory - recurring headline phrases become proposals;
  rejection is a 90-day cooldown by the user's decision, matched by words OR instruments
  (decisions 55-56);
- #63 (a parallel session): the search API's 429 diagnosed as load-shedding, retries added;
- #64: topic cards - a topic's news and tone, and which empty an empty list is;
- #65: discovery counts stories, not articles, and reads only linked headlines;
- #66: **GDELT read from its raw 15-minute files**, the search API deleted (decision 52);
- #67: MEMORY: the raw feed live, debt for everyday-word names;
- #68: discovery ranks multi-word phrases first; six more everyday words;
- #69: `sendDigest` takes `now` - its test had started failing on `main` when the date changed.

**Real news arrives, from GDELT's raw files (#66, decision 52), since 2026-09-27 19:35 UTC.** The
search API it replaced refused most requests and, when it answered, stored mostly unlinked noise
(1 of 17 linked on its last success). The first raw-file run read 8 files and stored 18 articles,
**all 18 linked** to followed instruments; the overnight runs stored 24-47 linked articles each.
Two known gaps, both in the debt table: company names that are everyday words ("Apple" the fruit)
link falsely, and auto-discovery has run once on real headlines and proposed nothing - correctly,
but it has not yet been shown finding a theme, which is M5's exit criterion.

The resolver still finds **14 of 35** expected tickers on the user's held-out batch, and nobody
changed its thresholds. The add-a-ticker box is how a confirmed set closes that gap (decision 46).
`docs/TOPIC_RESOLUTION.md` holds the measurements and the backlog.

The M3 closing summary (PRs #42–#47) is kept below in "Where to go next" and the decisions list.

**One-line state:** the product imports a portfolio, fetches six months of real daily prices, scans
it every 30 minutes for four kinds of finding, explains each one in sentences whose every figure is
checked against the evidence, **links every term in those sentences to an explanation of it**,
**answers a question phrased in the user's own words with the passages that bear on it —
by meaning, not by shared vocabulary — and says so when it is not sure**, lets
the user state the allocation they meant to hold, and turns the drift from it into a proposal with
a deadline that an approval writes to a paper ledger. No order is ever placed. The explanations are
currently written by templates rather than a model, and the app says so on its own dashboard.

**Telegram now works end to end locally** (2026-09-24). A chat is bound, and taps reach the ledger
through `TelegramPoller`, which long-polls `getUpdates` because the webhook still needs M7's public
HTTPS URL. Verified live: approve → undo → approve → undo from a real chat, each landing as an audit
row and a ledger row marked revoked. What remains unproven is only the *webhook* transport.

---

## Independent tasks queue

Work that depends on nothing in flight, so it can be taken while M5's exit proof waits on real
headlines (or at any other time). Created 2026-09-28 at the user's request, from a sweep of the
debt table and MILESTONES.md.

**The rule, set by the user:** when a task here is completed, **remove it from this queue**, and if
it is also part of a milestone, **remove it from that milestone's list in `docs/MILESTONES.md`**
too, in the same PR. The PR number is the record; neither document keeps a struck-through line.
Where the task also has a row in "Current technical debt", resolve that row in the same PR, as
that table already does. One task, one branch off `main`, one PR (no stacked PRs).

Ordered by the recommendation made when the queue was written: small correctness first, then the
unblocked feature, then structure. Numbers are kept when a task leaves, because other text refers to
them; task 1 (money at the currency's exponent) was done in #73, task 2 (the narration notice,
decision 58) in #74, task 3 (the Topics page in a browser) in #75, and task 4 (the Postgres CI
job, approved by the user 2026-09-28) in #76, and task 5 (quotes carry asset class and exchange) in
the PR after that. Task 7 (server state in TanStack Query) was done across #90-#92 and the topics PR
that closed it, and task 6 (a screen for `/ask`) in M6 PR 10. **The queue is empty**; the table is
kept so the next sweep has somewhere to add to.

| # | Task | Milestone | Size | Where, and what "done" means |
|---|---|---|---|---|

**Not in the queue, and why** - so they are not added back by the next sweep:
- *Everyday-word company names* ("Apple" the fruit): the user deferred it to a dedicated PR after
  more data.
- *Names ending in ", LP"*: fixing it moves topic resolution, which cannot be measured honestly
  without a new held-out batch (batch 3) written by the user.
- *Citing news in observations* (`articles=()`): would cite the fruit headlines as evidence; after
  the everyday-word fix.
- *Splitting `queries.ts`*: changes CLAUDE.md's "all SQL in one file" rule - the user's decision.

---

## Milestone status

| Milestone | Status | Notes |
|---|---|---|
| **M0 — Repo skeleton & contracts** | ✅ Complete | monorepo, compose stack, CI, OpenAPI contract + generated client |
| **M1 — Vertical slice** | ✅ Complete | portfolio in, valued portfolio out |
| **M1.5 — Trustworthy quote path** | ✅ Complete | **unplanned**; inserted after an audit found data problems M2 would have built on |
| **M2 — Analysis engine & observations** | ✅ Complete | PRs #12–#22 |
| **M2.5 — Real price history** | ✅ Complete | **unplanned**; PR #23. Finished M1's provider layer, 18 PRs late |
| **M3 — RAG & educational engine** | ✅ Complete | #42: corpus, schema, ingestion, live concept links. Slice 2: `vector(1536)`, `BaseEmbedder`, `VectorStore`, hybrid retrieval and `GET /concepts/search`. #45: the paid embedder. #46: `POST /ask`, intent routing, citations, a three-state relevance floor. #47: the 35-case eval set in two CI tiers. **The relevance floor is measured to be in the wrong place — see the debt table** |
| **M4 — Scheduling, HITL & Telegram** | ✅ Complete | PRs #26–#33. Mastra adopted for `proposalLifecycle` only |
| **M5 — Market discovery & topics** | ✅ Complete | #50–#51: eval set, universe, resolver. #53–#55: resolve, CRUD + confirm, Topics screen. #57: topic observations. #58–#59: news collection, GDELT. #60: topic sentiment. Digest topic section (this handoff's PR). **Recall on held-out topics: 14/35.** Auto-discovery with rejection memory (decisions 55-56). Topic cards: news and tone on the topic's card, with the last collection's state so an empty list is never called a quiet week. #79-#81: discovery collapses wordings of one story and drops one company's news (decision 59). #83-#86: indexed discovery, the market feed, the one-country rule, weak proposals (decisions 60-62). **Exit shown live 2026-09-29** ("data center" proposed; a rejection held) |
| M6 — Frontend completion & polish | **In progress** | #88-#96 merged: fixes from the browser review, the validator's cents bug, TanStack Query everywhere (task 7 closed), page addresses, the equity curve, fixture prices kept out of a real installation. #98: the backfill's still-trading closes. PR 8: the holding page (decision 68). PR 9: the proposals inbox and pages (decision 69). #101: looping model text rejected. PR 10: the `/ask` screen (decision 70). PR 11: the feed, paged and filtered (decision 71). PR 12: the mobile pass (decision 72). Left: mobile pass, times/disclaimers - see "Next session: M6, continued" |
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

The corpus is a derived copy and is not covered by any of those. `cd services/ai &&
DATABASE_URL=postgresql://traders:traders@127.0.0.1:55432/traders .venv/bin/python
scripts/ingest_corpus.py --dry-run` answers whether the database is in step with `data/corpus/`.

Test counts (2026-09-30, after PR 12): **1,691** — 840 Python, 553 orchestrator, 282 web, 16 shared - plus
**22 Postgres integration tests** (13 Python, 9 orchestrator) that skip without `TEST_DATABASE_URL`. Plus two
eval sets, which are not test counts: `/ask`'s **35 cases** (16 keyless on every PR, all 35 when
keyed), and the topic eval's **31 cases** (`scripts/run_topic_eval.py`, keyed only, **not in CI**).

**The SQL has its own CI job: `postgres (integration)`** (independent task 4). The ordinary suites
stay hermetic - the Python suite has no Postgres and the orchestrator's tests substitute
`db/queries.ts` - and the SQL runs in a job with a real one, opt-in by `TEST_DATABASE_URL`
(never `.env`), refusing any database whose name does not end in `_ci` or `_test`:
- `services/ai/tests/integration/test_migrations.py`: every revision round-trips (down, up over
  what the downgrade left, down) from head to base over `seed_head.sql`, which must hold a row
  for **every value any CHECK enumerates** - read from `pg_constraint`, so a migration that adds
  a value fails CI until the seed carries it. Deliberate refusals (0014's) are listed in
  `KNOWN_REFUSALS` and must keep happening;
- `test_retrieval_sql.py`: hybrid search, the ORed/ANDed lexical half, the model filter and topic
  resolution over data loaded by the real ingest scripts;
- `apps/orchestrator/test/queries.postgres.test.ts`: the narration ledger's lock, notification
  and observation dedupe.
Each was shown to fail against the bug it pins (0021's constraint order, 0006-style upgrade over
rows, the untyped `:model` parameter, a removed row lock). Locally:
`docker exec traders-postgres-1 psql -U traders -d traders -c 'CREATE DATABASE traders_ci'`,
then `TEST_DATABASE_URL=postgresql://traders:traders@127.0.0.1:55432/traders_ci` in front of
pytest (Python first: it migrates) and `vitest run test/queries.postgres.test.ts`.

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
| `GET /concepts/:slug` | the explanation behind a concept chip (#M3). 404 means the corpus is not ingested, not that the app is broken |
| `POST /ask` | a question in, a checkable answer out. **A refusal is a 200** with `answered: false` — declining an out-of-index question is an outcome, and a 4xx would make it look like a broken corpus. `answer_source` is `extractive` \| `llm` \| `computed` \| `none`; `computed` is arithmetic over holdings and is *never* a model |
| `POST /topics/resolve` | `{topic}` → candidates with band, quoted rationale and `held_by`. **`verdict` has four values**; `unavailable` (with `universe.state`) means the universe was *not searched*, and is never the same as `none` (decision 47). Stores nothing |
| `GET`/`POST /topics`, `GET`/`PUT`/`DELETE /topics/:id` | the user's topics. `POST`/`PUT` take `{label, symbols}` and **re-resolve on the server** to decide which symbols carry reasons (decision 48). 422 `topic_limit_reached` / `unresolved_symbols` (with `details.symbols`), 409 `duplicate_topic` |
| `POST /topics/:id/reject` | decline an auto-proposal; it becomes rejection memory for `TOPIC_REJECTION_COOLDOWN_DAYS`. `DELETE` on a proposal is a 409 `topic_is_proposal`, because deleting would erase the memory |
| `GET /runs?kind=topic_discovery` | why nothing was proposed: every phrase examined has a reason in `notProposed` |
| `GET /concepts/search?q=` | hybrid retrieval: the half of `/ask` that finds things. A diagnostic surface with no relevance floor and no refusal — those are `/ask`'s judgements. Every match reports `vector_rank` and `text_rank`, so *which half found this* is answerable; `vector_is_semantic: false` says the embedder ranks by shared words alone |

---

## What exists, by area

**`services/ai`** (Python, FastAPI) — market data providers behind a chain with caching, rate
limiting and per-provider daily budgets; four deterministic analysis rules; news ingestion with
entity extraction; an LLM provider factory with a daily spend guard; narration behind an evidence
validator; **the concept corpus: structure-aware chunking, hash-compared ingestion and slug
lookup, and **hybrid retrieval over it: an embedder behind `BaseEmbedder`, a `VectorStore` over
pgvector, and reciprocal-rank fusion of the vector and full-text halves**; **topic resolution
(M5): a committed, rule-screened instrument universe (`data/universe/`, `app/universe/`), profiles
embedded with the company's own name stripped, ETF holdings, and `app/topics/resolution.py`, served as `POST /topics/resolve`**; the Alembic schema (17
migrations) that both services share.

**`apps/orchestrator`** (Node, Hono) — sessions, holdings CRUD, CSV/JSON import with per-row
validation, valuation with FX, target weights, the scan workflow, run claims, the observations feed,
the local scheduler, **the proposal state machine and its audit trail, the notification fan-out, the
Telegram adapter, per-user settings, and topics with confirmed instruments (`services/topics.ts`)**.

**`apps/web`** (React, MobX, Tailwind, Recharts) — login, portfolio dashboard, import wizard,
observations feed with an evidence drawer, the approvals inbox, a settings page, the concept
dialog behind the feed's chips, **and the Topics page with its confirm screen (`TopicsStore`)**.

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

24. **M3 was sliced so that no embedding dimension is guessed.** Slice 1 ships the corpus, the
    schema, ingestion and live concept links with **no `vector(n)` column at all**. That column is
    a commitment to one embedding model: `n` is fixed at creation, pgvector's HNSW index is built
    per dimension, and correcting a guess costs a migration plus a full re-embed. Nothing in slice
    1 needs one — a concept link is an exact slug lookup, and the full-text index covers keyword
    search — so the choice is deferred to slice 2, which can make it on evidence. The remaining
    slices are (2) `VectorStore`, an embeddings provider and hybrid retrieval, with a deterministic
    fixture embedder so CI stays hermetic and keyless; (3) `POST /ask` with intent routing,
    citations and a relevance floor; (4) the ~30 Q/A eval set in CI.

25. **A chunk id is what a citation points at, so ingestion compares before it writes.** The
    obvious implementation — delete a document's chunks and re-insert them — is cheap to write and
    wrong in a way that only appears later: an id replaced on every run cannot be cited by anything
    that outlives the run. So a content hash over every chunk's text, heading and position decides
    whether the document is touched at all, and when it has changed, chunks are upserted on
    `(document_id, ord)` so only the sections that actually changed are rewritten. The hash
    deliberately excludes title, source, uri and licence: correcting a typo in a title must update
    the row without churning ids. The consequence worth knowing is that **re-ingesting an unchanged
    corpus performs no writes at all**, which is what makes it safe to run on every stack start and
    on every file edit.

26. **Definitions and article text never share a namespace, and every query says so.** The
    `namespace` column was in the schema from the start; what was *not* obvious is that every
    statement touching `kb_documents` has to filter on it. A `news` document carries a null
    `concept_slug` by design, so a query that forgets the filter reads ingested articles as
    orphaned concepts — and the ingester's `--prune` would then delete them as a side effect of
    loading definitions. See the bug below; the lesson is that a nullable discriminator is only
    safe if every reader knows about it.

27. **The concept endpoint lives in the AI service, and the orchestrator only proxies.** The corpus
    belongs to the service that owns the schema, the ingester, and — when `/ask` lands — the
    retrieval that will read these same tables. A second reader of `kb_chunks` in another process
    would be a second place that has to agree about section ordering and namespace filtering. It is
    the same argument `app/routers/narration.py` makes in its own docstring for serving the LLM
    configuration from there, and it is why `GET /concepts/:slug` on the orchestrator contains no
    logic but error mapping.

28. **An upstream status is translated, never forwarded.** `upstreamFailure` passes 503 and 504
    through and rewrites everything else to 502. Forwarding blindly looks more honest and is worse:
    a 401 from the AI service means *our* internal key is wrong, and passing it to the browser
    tells the reader their session expired and sends them to log in again over a server
    misconfiguration they cannot affect. A 404 is the one genuine exception and is mapped to a
    named 404, because a corpus nobody has ingested is a real state rather than a fault.

29. **Corpus text is parsed into React elements, never rendered as markdown.** The documents reach
    the browser through two services from a database anyone with a shell can write to, so a
    markdown library would mean either `dangerouslySetInnerHTML` or a sanitiser to maintain.
    `conceptText.ts` understands exactly four constructs — paragraphs, four-space formula blocks,
    `**bold**` and `*italic*` — and anything else degrades to plain text, so no HTML is ever built
    from that text at all. The cost is real and accepted: adding a list or a link to a document
    means changing the parser, and a test over the shipped corpus fails until someone does.

30. **The reranker was moved from slice 2 to slice 3, and the embedding width
    was not guessed.** DESIGN.md specifies "vector + FTS + RRF + rerank", and the
    rerank is the one piece of that sentence that could not be built here: it
    reorders a candidate list, and until slice 4's eval set exists there is no
    way to tell a good reordering from a bad one. A component nothing can
    measure, sitting on the path where being subtly wrong looks exactly like
    being right, is worse than an absent one. **`n` = 1536 is the width of
    `openai/text-embedding-3-small`**, the model the owed migration targets, and
    the migration says so in prose — decision 24 deferred the number so it could
    be chosen on evidence, and a fixture embedder exerts no pressure on it at
    all, which is precisely what makes a convenient guess so easy. 1536 also
    keeps the cheap upgrade open: `text-embedding-3-large` truncates to 1536 via
    the `dimensions` parameter, so moving up later is a re-embed and not a
    migration.

31. **The fixture embedder is lexical rather than random, and that was the
    argument.** Hashing the whole text into a pseudo-random vector is simpler
    and was rejected: random vectors make the vector half of retrieval
    *untestable*, because there is no input for which a correct implementation
    returns a particular row — so the ranking SQL, the fusion and the ordering
    could all be wrong in CI and look exactly like working code. A hashing-trick
    embedder over word tokens has checkable behaviour, so the retrieval path is
    exercised by tests rather than merely executed by them. The honest cost is
    that it correlates with the full-text half, so fusing the two adds less than
    fusing independent rankers would — a property of the placeholder that
    disappears with the real model. It has **no semantic knowledge whatsoever**,
    and every search response says so on the wire (`vector_is_semantic: false`)
    rather than in a log, because a ranking produced by shared words is
    indistinguishable from one produced by understanding.

32. **`/ask` refuses in three different ways, and they are kept apart.** Below the
    relevance floor means the corpus does not cover it; `no_holdings` means the caller
    did not send a portfolio; `not_computable` means the question is outside the short
    list of things arithmetic can answer. Collapsing them would tell someone their
    question was out of scope when the truth was that their portfolio had not loaded —
    the same class of error as a notification that vanishes (decision 18).

33. **The relevance floor has three states because the measurement supported three.**
    Eight in-domain and eight out-of-domain questions separated by **0.0289** of cosine
    (lowest in-domain 0.2498, highest out-of-domain 0.2208). That is enough to tell
    clearly-relevant from clearly-irrelevant and **not enough to draw a line**, so
    between the bounds an answer is given and *labelled weak* rather than a coin-flip
    being reported as a decision. Same instinct as `null` for an unpriced holding: the
    uncertain case gets its own value instead of being rounded into a confident one.
    The floor is on **cosine** and not on the fused RRF score, because RRF is a function
    of how many halves returned a chunk and where — the same number means different
    things for different queries. Cosine is bounded and behaves the same way across
    queries, which is the only property that makes a fixed threshold meaningful.
    **The floor abstains entirely when the embedder is the fixture** (CI's path): those
    similarities measure shared words and are not on the scale the thresholds were
    measured against, so applying it there would refuse or admit at random while looking
    like a considered decision.

34. **A portfolio answer is never written by a model, and the wire says so.**
    `answer_source: "computed"` is arithmetic over what the caller supplied, checked by
    the same evidence validator narration uses. A plausible wrong number about someone's
    money is the worst output this product could produce, and the set of computable
    questions is therefore short, explicit and listed — the `PROPOSABLE_KINDS` argument
    applied to questions.

35. **The eval set is held out from the thresholds, and a test enforces it.** `relevance.py`'s
    numbers were fitted to sixteen questions and the lexical switch to six more. An eval that
    reused any of them would test the thresholds on the data that picked them — which measures
    nothing and looks exactly like a pass. The fitting questions are recorded in
    `data/eval/ask.json` and `test_eval_set_contract.py` fails if a case repeats one (confirmed
    by planting one with different casing and whitespace). The disclosure that goes with it: every
    case was written by the session that had read the whole corpus. Held-out from the thresholds
    is not the same as held-out from the author, and **questions from someone who has never read
    the corpus would be worth more than any number of these**.

36. **At the relevance boundary, the answer hedges instead of the threshold moving.** The first
    keyed run found "what is the current price of gold" (out of domain) at **0.2502** and "why
    does my mix keep changing on its own" (legitimate) at **0.2498**. They overlap; no threshold
    classifies both. Raising the floor would have swapped a wrong answer for a wrong refusal *and*
    turned the held-out set into a training set. So a weak match now opens with
    `WEAK_MATCH_PREFIX` — "I'm not sure the reference corpus covers this. The closest match I
    found is:" — applied by the service from the verdict, never by a model, so whether an answer
    admits uncertainty cannot depend on how a model phrased it. `relevance: weak` had been on the
    wire from the start, but the *text* of a weak answer was identical to a confident one, so a
    reader of the reply alone got no signal at all. Decided by the user, 2026-09-24.

37. **The keyed eval tier is opt-in by the presence of a secret, and skips visibly.** CI stays
    hermetic for anyone without `OPENROUTER_API_KEY` — forks, fresh clones, a spent budget —
    because the job then prints a `::notice` and succeeds, instead of turning every PR red for a
    reason unrelated to the change. A notice rather than silence, because a green job that did
    nothing looks exactly like a green job that tested the refusal path. It is the *only*
    automated test of the `not_in_corpus` refusal, because the floor abstains on the fixture.

38. **The topic eval was written by the user, before the resolver existed, and its second batch was
    sealed.** `data/eval/topics.json`. A contract test fails if a user case differs from what they
    wrote except through a named correction (SQ → XYZ is the only one), and threshold-fitting topics
    are written down *before* measuring and kept disjoint by test. Batch 2 was handed over after the
    first run and not run until slice 2 was final — and it is what showed slice 2 did not
    generalise. **It is now spent**; the file says so.

39. **The universe is screened by rule, never assembled from the answers.** Primary US exchanges,
    stocks ≥ $1B, ETFs ≥ $100M (thematic funds are small); preferred series dropped; one listing
    per company (most traded). All of the user's tickers are in it and none was added by hand — a
    universe built from the eval's answers would make every case a choice among correct answers.

40. **Yahoo's descriptions are not committed; membership, facts and holdings are.** The prose is
    licensed from Yahoo's vendors, so it lives in `data/universe/descriptions.local.jsonl`
    (gitignored) and the database, with a `license` column. Consequence: a fresh machine must run
    the build script (~1 h, rate-limited) before topics can resolve. Holdings are fund composition —
    facts — and are committed.

41. **`instrument_profiles` is its own table, not a third `kb_chunks` namespace.** pgvector's HNSW
    returns at most `ef_search` (40) rows *before* the WHERE clause; 3,600+ instrument vectors in
    the concept index could leave `/ask` with nothing and no error. Same reason
    `search_profiles` raises `hnsw.ef_search` to its LIMIT: otherwise "top 50" silently means 40.

42. **Profiles are embedded with the company's own name removed** (`app/universe/matching_text.py`).
    "fast food" admitted Fastenal and "mount everest" found Everest Group. Stripping moved the
    nothing/something separation on the fitting topics from **0.018 to 0.120**. The stored
    description stays verbatim because rationales quote it; the hash is over the embedded text plus
    a rule version, so changing the rule re-embeds exactly once. Holdings matching uses a
    *stricter* name rule than news (`legal_core` keeps "Group"): the news rule matched Compass
    Group to Compass, Inc.

43. **Similarity decides whether; size decides the order.** Specialists outranked the companies
    people mean (Newmont 15th for "gold mining"). The gate (band + floor + cap 30) is what stops a
    giant climbing a list it barely belongs to. **Rejected with measurements:** a size-scaled gate
    (put NVDA/MSFT at #1–2 for "video game publishers"), query-expansion dictionaries, raising the
    candidate limit, consensus of ≥ 2 source ETFs. The table is in `docs/TOPIC_RESOLUTION.md` §5.

44. **ETF holdings bypass the gate, but only from coherent funds.** A fund is a source if it is near
    the topic *and* its holdings are (mean similarity within 0.13 of the best match). Without the
    second test, broad funds brought Amgen into "gene editing" and Home Depot into "home builders",
    and size ordering put them first. Holdings with weight outside (0, 1] (cash lines, wrappers, one
    reported at 66,880%) are skipped and counted, not stored.

45. **Rationales are quoted, never written; confidence is a band, never a percentage.** The same
    argument as the evidence validator: a model can write a plausible false sentence about a real
    company, and a cosine is not a probability. `held_by` ("SHLD 10.8%") is the second, checkable
    reason.

46. **The resolver stops at 14/35 on held-out topics, and the next step is product, not tuning.**
    The M5 exit criterion is a *confirmed* set. A confirmation screen where the user adds what the
    resolver missed closes the gap regardless of recall; further resolver work needs a new held-out
    batch first, or it can only be measured on data that shaped it.

47. **An unloaded universe is `verdict: unavailable`, never `none`** (`POST /topics/resolve`).
    `none` says the universe was searched and holds nothing about the topic. `unavailable` says
    nothing was searched, and `universe.state` names the missing step. The coverage count runs
    *before* the resolver, because over an empty table `judge(None)` grades the missing evidence
    `weak` with no candidates. A 200, like `/ask`'s refusal, so it is a typed state and not a
    status code a caller can misread.

48. **Confirming re-resolves on the server; the browser never supplies a reason.** A confirm
    sends `{label, symbols}` only. A symbol is stored as `resolver` with its band, quoted rationale
    and `held_by` only if re-resolving the label offers it *now*; otherwise it is a bare `user` row,
    checked through the same instrument lookup as a new holding. The rejected alternative (posting
    back what the browser was shown) lets any client write text the topic card presents as a
    quotation. Consequence, seen live: relabelling "uranium" to "nuclear fuel" turned BWXT into a
    resolver row and CCJ into a user row. That is correct, because provenance belongs to the label
    that was confirmed.

49. **There is no unconfirmed user topic.** A topic exists from the moment its set is confirmed
    (`POST /topics`). DESIGN.md's `confirmed_by_user` flag was dropped: only confirmed instruments
    are stored, because an unticked suggestion kept as a row is data nobody chose. It would also
    need filtering by every later reader (topicScan, the news matcher, the digest). `proposed` exists
    for auto-discovery only. **The cap (10 active topics) is enforced under a lock on the user's
    row**. It was raced live with three simultaneous confirms for one free slot, and exactly one
    won.


50. **A topic observation is one finding about the basket, never a list of member findings.**
    `topic_move` measures the confirmed set as an equal-weighted basket and z-scores its move
    against the same basket's own recent days, reusing `sigma_move`'s thresholds and guards.
    Equal weight because a confirmed set has no weights; market-cap weight would make every topic
    containing a giant a statement about that giant. Two refusals are its own: fewer than
    `TOPIC_MIN_MEMBERS` priced, or less than `TOPIC_MIN_COVERAGE` of the set priced on the session
    (the same floor filters which historical days enter the sample). Both are reported by label in
    `runs.stats.skipped`, and the run is `degraded`. It raises no proposals and carries no news,
    because none is collected (see the debt table). Replayed over 120 real sessions for
    UGA+VLO: 9 findings, all `info`, 0 unsourced figures.

51. **A topic's news is derived through its instruments; no `topic_id` in the news tables**
    (migration 0018, which also settles 0004's deferred promise). Articles and their links are
    shared market data with no `user_id`; a topic is one user's choice, so a key from a shared
    row to a user-owned one would make the corpus per-user by the back door.
    `GET /topics/:id/news` joins `topic_instruments` → `article_entities` → `articles` at read
    time. `topic_ref` stays unused for GDELT's query-found articles that name no instrument.
    The `news_collect` matcher sees held and topic instruments only, never the universe.

52. **GDELT is read from its raw 15-minute files, filtered by headline; the search API is gone.**
    (User's decision, 2026-09-27, after a day of measurements.) The DOC search API refused most
    requests (load-shedding; no retry schedule got through reliably), and the one batch that got
    through was mostly noise: it matches a name anywhere in the body but returns only the headline,
    so 68 of 77 stored articles named nothing followed, and titles came back re-spaced ("U . S .").
    `app/news/gdelt.py` now downloads each slot's GKG file
    (`data.gdeltproject.org/gdeltv2/YYYYMMDDHHMMSS.gkg.csv.zip`, ~3 MB, several hundred English
    articles; answered in 0.6 s while the API refused) and keeps a row only when its
    `<PAGE_TITLE>` names a followed instrument by the matcher's own spellings (`names`) -
    **headline-only, by the user's decision**: GKG's organisation list would find more, but the
    headline shown and read for themes would then not mention what it was kept for. The headline
    is still the body, and `published_at` is the slot time. **Which files: a cursor**
    (`news_feed_cursors`, migration 0020), written in the collection's transaction so a file is
    marked read only if its articles are stored; oldest first, at most 16 files a run, 2 hours
    back when there is no cursor, never older than the run's `since`. A 404 within 45 minutes of
    its slot is late (stop, retry next run); later, it is missing (counted, passed over).
    Rejected: no cursor and re-reading the last hour each run (double the downloads; an outage
    longer than the overlap loses news silently). A failure partway still raises with the files
    read so far on `NewsProviderError.partial`. **Deleted with the API:** request spacing, the
    8-name OR batching, `query_terms`, the 10 s / 30 s retries, the throttle-sentence parsing.

53. **A topic's sentiment is a magnitude-weighted mean from one model, or a null with a reason.**
    `GET /topics/:id/sentiment` (FR-12), computed in `services/topicSentiment.ts` from rows the SQL
    returns unaggregated, so the arithmetic is unit-tested and the article set is exactly
    `/news`'s. Weighted because a lexicon score is a balance: one "record" scores +1 like an article
    of nothing but good news, and a headline with no polar words expressed no tone rather than a
    neutral one, so it gets no weight. **Never a 0 for "unknown"**: `gap` is `no_articles`,
    `not_scored` or `too_few_polarised` (< 3). Scores from different models are never averaged
    together (`lexicon-v1` is comparable only with itself); others are named in `otherModels`.
    Days bucket in the user's timezone. Computed at read time rather than stored, because a
    stored per-topic score would be per-user derived data that goes stale the moment a late article
    arrives; a sentiment *observation* (a shift worth announcing) is the digest slice's decision.

54. **The digest's topic section quotes headlines, keeps three states apart, and never makes a quiet
    day loud.** `services/topicDigest.ts`. A topic move is quoted by its stored headline (already
    evidence-checked), never re-rendered. "No unusual move" is said only of a topic the last
    `topic_scan` measured; a topic in that run's `stats.skipped` is "not measured (reason)", and one
    confirmed after the run is "not scanned yet". The section exists only when some topic moved or
    had an article *today* (user's timezone); a day on which every topic was quiet still sends no
    digest, which was the existing rule and is kept - a daily "all quiet" message trains the user
    to mute the channel. The deferred entries' all-or-nothing settlement is unchanged; the topic
    section has nothing to settle.

55. **Auto-discovery proposes from phrases recurring in headlines, filtered before it is resolved.**
    `app/topics/discovery.py` finds 1-3-word phrases in at least 3 distinct **stories** from at least
    2 outlets over 7 days (`POST /topics/discover`, reads only, no embedding), reading **only
    headlines linked to a followed instrument**. Both were added after the first real headlines
    (2026-09-27): counted by article, one AI-safety wire story republished by three outlets under
    slightly different headlines made "alarm", "controlled" and "openai sound" themes; and 68 of
    77 stored articles linked to nothing (the search API matches body text) and read as themes
    they were noise ("fiber" from a recipe). Headlines are one story when 80% of the shorter one's
    words, followed names excluded, are in the longer one; phrases found in exactly the same
    stories are one candidate, and so are wordings nested in each other when the longer is in at
    least `VARIANT_SHARE` (0.75) of the shorter's stories - transitively, so "open agent safety"
    and "agent safety platform" join through "agent safety". 0.75 sits in a measured gap
    (2026-09-29 headlines: rewordings of one story at 0.75-0.92, a word with a life of its own at
    0.71 and below); before it, one Nvidia launch took 7 of the 8 resolve slots. Followed instruments'
    names are cut out of each headline *before* phrases are built, or "NuScale Power" would count
    towards "power". The orchestrator (`services/topicDiscovery.ts`, run kind `topic_discovery`,
    daily) drops phrases matching a known theme **by words first**, then resolves at most 8
    through the ordinary `/topics/resolve`, proposes only a `confident` verdict with at least 2
    confident instruments, and checks **instruments** after. Filtering before resolving is not a
    cost trick only: a rejected theme recurring daily at the top of the list would otherwise hold
    a resolve slot forever. At most 3 proposals open at once, counted under the topic-cap lock.
    A proposal is a question, not a subscription: not scanned, no news, not counted against the
    cap; accepted through `PUT /topics/:id` with nothing pre-ticked. **Limit, stated rather than
    hidden:** news is collected only for followed instruments (decision 51), so discovery finds
    themes *next to* the user's interests, never in a corner of the market they never looked at.

56. **Rejection memory: words OR instruments, inside a cooldown - and the instruments are every
    candidate offered, not the confident few.** Matching is `services/topicMatching.ts`: suppressed
    if every word of the known label is in the new one (case, plurals, filler ignored; one-way, so
    "energy" is not blocked by a rejected "nuclear energy"), or if at least half of the new
    proposal's instruments are in the known set. The same rule decides "already followed" and
    "already pending", so those can never disagree with "rejected". **Cooldown, not forever**, by
    the user's decision on 2026-09-27: `TOPIC_REJECTION_COOLDOWN_DAYS` (default 90). This amends
    MILESTONES' exit criterion; the rejected row is kept after the window (decision 18). The
    fingerprint is frozen on the row at proposal time (`match_words`, `proposed_instruments`,
    migration 0019), so a universe change cannot un-reject anything. **Measured on the real
    resolver before merging:** confident sets are 2-4 instruments and "nuclear fuel" shared *none*
    with "uranium"; over every offered candidate it shares 57% and "uranium miners" 100%, while
    "data centre" and "lithium" share 0%. The first version fingerprinted confident candidates only
    and would have let "nuclear fuel" straight back. "nuclear energy" sits exactly at 50% and is
    suppressed - the rule errs towards suppressing, because showing a rejected theme again is the
    failure memory exists to prevent, and a missed suggestion is the cheap one.

57. **An unanswered proposal expires into its own status, not a deletion and not a rejection.**
    Migration 0021, `expireProposals`. Without it, three ignored proposals held every slot and
    stopped discovery for good. After `TOPIC_PROPOSAL_TTL_DAYS` (default 14; it and the 7-day hold approved by the user
    on 2026-09-28 as defaults, not measured) the
    row becomes `expired` with `expired_at`: kept for decision 18's reason, and not `rejected`
    because silence is not a "no". An expired theme is held back for **one discovery window**
    (`EXPIRED_HOLD_DAYS`), so it can return, but only on headlines that all postdate the silence -
    never the next morning. **The sweep runs only at the start of a discovery run**, before the
    no-headlines early return, rather than on every read as proposals' expiry does (decision 16):
    here a past-deadline proposal that is still visible is harmless (accepting it is the user
    choosing a topic), and the slot only matters to discovery. Every reader filters on
    `LIVE_TOPIC` (`status IN ('active','proposed')`) rather than excluding one dead status, so a
    third cannot leak into a list. The downgrade turns expired rows into rejections, which errs
    towards suppressing; its first version failed over a real expired row because the UPDATE ran
    while the new CHECK still existed - the constraint-meets-data lesson again, found by running
    it with a row present.
58. **Narration's state is a ledger of transitions, judged over the last three explanations, and only
    the model/template boundary is announced.** `services/narrationWatch.ts`, migration 0022.
    `GET /narration` recomputes the state per read, which cannot say what *changed*, so
    `narration_transitions` stores a row only when the state differs from the last one; its newest
    row is the current state, the first row (`from_state` null) is a baseline and never announced
    (an upgrade is not a transition), and a lock on the user's row stops a portfolio and a topic
    scan finishing together from both recording it (raced live: one row). **Judged over
    `NARRATION_WINDOW` = 3 explanations across scans, not one scan:** replayed over this
    installation's history 2026-09-17..28, a per-scan rule announced a break fifteen minutes after
    a recovery, over two refused sentences; the window gives two breaks in five days, both real
    streaks. **A break is `high` and pushes; a recovery or `off` is `info` and waits for the
    digest** (the user's decision, 2026-09-28). A move between two template states
    (`unavailable` -> `rejected`) is recorded and not announced. Delivered through `fanOut` with
    `ref_kind = 'narration'`, so quiet hours, a mute and the dedupe key apply unchanged; the digest
    names where explanations ended rather than counting the notice as a finding. The badge and the
    notice can disagree for a scan: the badge reads the latest scan, the notice the window.

59. **A phrase that is one company's news is not a theme, and is not resolved.** The AI service
    reports each phrase's lead instrument and how many of its articles link to it
    (`lead_instrument`, `lead_instrument_articles` on `/topics/discover`) and judges nothing; the
    orchestrator drops a phrase at `SINGLE_INSTRUMENT_SHARE` (0.75) or more, *after* rejection
    memory (so a rejected theme still says "rejected", which the exit check reads) and *before*
    the resolve budget. The reason names it: "100% of its headlines are NVDA news". **Measured
    before building** (2026-09-29, 648 headlines, 12 followed instruments; the feed was NVDA 35%,
    AAPL 34%, BTC-USD 14%, MSFT 12%): multi-word phrases' lead shares ran 0.60, 0.67 (x4), then
    0.80 and up, 49 of 58 at 1.0, and all ten top-ranked phrases were NVDA or AAPL news. The gap is
    real but thin - everything under it had 3-5 articles, one about another company. **Drop, not
    rank-last, by the user's decision:** on that data both spent the budget identically (170
    single words sit below the bar), and only drop records the true reason. Nothing that survived
    was a real theme, which is the source's limit (decision 51), not the rule's. **Built to outlive
    that limit:** articles linked to no followed instrument count in the denominator, so when a
    market/sector feed arrives (planned by the user, with the UI split into "Portfolio Impact" and
    "New Opportunities") a real theme reads as spread and only the headline loader changes.
    `nasdaq`, `us`, `release(s)` went into `GENERIC_WORDS` in the same PR. **Found after
    agreeing on drop, and corrected in the same PR:** the orchestrator asked for only the top 20
    phrases, and 19 of them were company news - the run would have resolved one phrase and left
    seven slots unused. `PHRASES_REQUESTED` is now 100 (the service's maximum; asking costs no
    embedding). The lesson: simulate the whole pipeline, including the caps before a filter, not
    only the filter.

60. **A market feed rides on the same GDELT files, for discovery only.** `app/news/market_feed.py`,
    migration 0023 (`articles.feed` = `followed` | `market`). A row is market news when GDELT
    tagged it with a market theme (`MARKET_TAGS`, column 8) **and** its headline uses market
    vocabulary (`MARKET_WORDS`/`MARKET_PHRASES`); either alone was too wide (law-firm releases;
    "MasterChef star shares"). Decided with the user 2026-09-29, each measured read-only on raw
    GKG files first (three 24 h samples, then every slot of 2026-09-22..29):
    - **Volume:** ~4,000/day averaged over a week (5,400-5,600 on weekdays, 1,600-2,000 on
      weekend days) of GDELT's ~112k; one download serves both filters, so the cursor stays one.
    - **Outlets named, not detected:** `TICKER_NETWORKS` (88-95% of headlines carry "(TICK)";
      the next real newsroom, seekingalpha, is 0.63-0.77 - too thin a gap to automate) and
      `PRESS_RELEASE_WIRES` (their "class action" releases topped the list once the networks were
      out). Constants, not a table: a change is a reviewed PR with a measurement, like
      `GENERIC_WORDS`. Each `news_collect` run reports `suspected_networks` (unlisted outlet, 20+
      market headlines in a day, 0.85+ templated); it found `financialcontent.com` on its first
      data, which was then listed. The exclusion applies to the market filter only: a followed
      name in a network headline is still collected, as before.
    - **An unlinked market article reaches discovery and nothing else**, by construction: topic
      news, sentiment and evidence all join through `article_entities`. `feed` exists because 553
      old unlinked rows (the search API's noise, decision 55) must stay out of discovery.
    - **Retention = discovery window + proposal lifetime** (21 days), derived in
      `marketRetentionDays` and sent by the orchestrator, so every headline behind an open
      proposal is still readable. Only unlinked market rows are pruned. Size was not the reason
      (~110 MB at 30 days is nothing to Postgres here).
    - **Window stays 7 days.** 1-, 3- and 7-day windows found the same core themes; a 1-day
      Saturday run put "crore ipo" and "files draft papers" in its top 8. 7 days cost 69 s until
      #83 indexed discovery (2.8 s, identical output) - it would have timed out at the
      orchestrator's 30 s.
    - **No US-only filter at ingestion:** it lost "crude oil" (mostly non-US outlets) from the top
      8. Local news is left to a discovery-side rule (next PR: one non-US country's outlets at
      0.75+ of a phrase's articles is that country's news, mirroring decision 59).
    - **Portfolio Impact vs New Opportunities is derived at read time** (an article is Portfolio
      Impact for a user when linked to what they follow), so `feed` is the only stored
      distinction. The screen is M6.
    Result on the committed filter: the resolver returns `confident` for "data center" (DLR,
    APLD, CIFR...), "bond yields", "mortgage rates" and "crude oil". **Limit:** `news_collect`
    still skips when the user follows nothing, so the market feed stops with it.
    **Live after #84 (2026-09-29):** the first collection stored 151 market articles (none from an
    excluded outlet), and the first discovery run over them proposed **"data center"** (DLR,
    APLD, CIFR, GDS, CORZ, KEEL, BXDC) and **"bond yields"** - M5's exit criterion, first half -
    and one false "launches ai" (one Nvidia launch plus one other company's; newsroom verbs went
    into `GENERIC_WORDS` in the next PR). The false proposal was left for the user to answer.

61. **One foreign country's press is local news, not a theme.** The AI service reports each
    phrase's `lead_country` (the outlet's home country, from GDELT's own table committed as
    `data/outlets/countries.tsv.gz`, 2018, 98% coverage of feed rows) and judges nothing; the
    orchestrator drops a phrase at `SINGLE_COUNTRY_SHARE` (0.75) unless the country is
    `HOME_COUNTRY` ('US': the user trades US listings only, stated 2026-09-29), after the
    one-company rule and before the resolve budget. **The outlet's country, not the article's:**
    GDELT's per-article locations name places a story mentions, so oil-and-Iran stories are
    "Iran" wherever published. **Measured** over the week's top 100 phrases: local ones 0.78 and
    up (Indian IPOs, "sensex nifty" 0.97, RBA "cash rate" 0.95), then 0.67, and global
    commodities far below ("brent crude" 0.52, "gold silver" 0.51) - so crude and gold stay even
    though Indian outlets carry most of them. It frees 17 of the week's top 100; on the live
    window it drops exactly "cash rate", "reserve bank rate" and "fourth hike". **Rejected:** a
    US-only filter at ingestion (loses "crude oil"), and per-article country (above). Unlisted
    outlets count against the lead, which errs towards keeping a phrase.

62. **Weak proposals: their own band, their own cap, hidden until asked for.** Migration 0024
    (`topics.proposal_band`, required on every auto-proposal, kept after it is answered),
    `proposalVerdict` in `services/topicDiscovery.ts`, the "Show N weak matches" toggle on the
    Topics page. Decided by the user 2026-09-29: a weak proposal needs
    `MIN_WEAK_PROPOSAL_INSTRUMENTS` = 3 candidates (one more than a confident one's 2, because
    each is less evidence), and `MAX_OPEN_WEAK_PROPOSALS` (3) is separate from
    `MAX_OPEN_PROPOSALS` - a shared cap would let three weak ones block every confident one,
    the failure decision 57 fixed. **Also weak, by Claude's recommendation when the user said
    to continue without answering:** a `confident` verdict with fewer than 2 confident
    instruments but 3+ offered ("treasury yields": GOVI, then six weak) - otherwise it fell
    between the rules and was proposed nowhere. A weak proposal shows every candidate offered;
    a confident one only the confident. Rejection memory, expiry and the words/instruments
    match ignore the band, so a rejected weak theme is remembered exactly as a confident one.
    A band is judged only after resolving, so the run stops early only when **both** caps are
    full, and a phrase whose band has no room says so ("no open weak proposal slot left").

63. **The validator accepts a `_minor` figure only in its major form** (#89). It used to accept the
    raw integer too, so "fell to 4016 from a high of 4750" passed for a $40.16 price. Measured
    over every stored model narration: **4 of 11** carried cents as dollars, all approved. **The
    4 stored rows were rewritten by the templates** (`narration_source='template'`,
    `fallback_reason='unsourced_figures'` - what the validator would have done at the time),
    decided by Claude under the user's M6 delegation: leaving them kept hundredfold-wrong figures
    on the dashboard, and withdrawing them would have hidden real findings. Notifications already
    sent with those texts cannot be recalled.

64. **Server state lives in TanStack Query; MobX reads it through `CacheMirror`, never a copy.**
    `apps/web/src/queries/`: `queryClient.ts` (30 s stale time; retries only a network error or a
    5xx, at most 2 - a 4xx is an answer), `queryKeys.ts` (every key, once), one module per
    resource with its `queryOptions` and mutations. A write invalidates the query it changed
    rather than patching the cached response, because totals, weights and FX are the server's
    arithmetic. `RootStore` owns the client, so a store can invalidate (`ImportStore`) and
    sign-out `clear()`s it - cleared, not invalidated, which would refetch as nobody and keep the
    last account's numbers up until it failed. **`CacheMirror` exists for stores whose client logic
    is computed from server state** (`TargetsStore.rows` compares the draft with held weights): a
    MobX-observable, read-only view of one cache entry. It subscribes to the **query cache**, not a
    `QueryObserver`, because `clear()` removes the query object itself and an observer stays bound
    to the removed one - it would never see the next account's portfolio
    (`serverState.test.ts` pins this). A component's hook is still what fetches. Rejected: copying
    the response into the store (the exact debt being removed), and passing the portfolio into
    every `TargetsStore` getter (eight getters, and every caller would have to remember to).
    **Decisions on proposals stay in `ProposalsStore`** (the list does not): a decision needs a
    synchronous one-per-proposal guard - a double click lands before the re-render, so a
    per-card `useMutation` cannot give it - and an in-flight label two card components share.
    `decide()` cancels a read in flight, posts, writes the *server's* answer into the cache, and
    re-reads after every decision (the old store re-read only after an approve). **Gotcha that
    cost a test run:** a *function* `refetchInterval` is evaluated only when the query updates, so
    "pause while deciding" silently did nothing; `useProposalsQuery` reads the in-flight count
    during render and must be called from an `observer` (`inboxRefresh.test.tsx`). **Deliberate
    change:** TanStack skips interval re-reads while the page is hidden and re-reads on return;
    the old store polled a hidden tab. The in-app browser pane counts as hidden when not in
    front, so an interval cannot be observed there - it is pinned by that test instead.
    **Forms keep only their edits.** `SettingsStore.edits` and `TargetsStore.edits` hold what was
    typed; `saved` is a `CacheMirror` read, and the form shows edit-or-saved. So a background
    re-read never overwrites a half-typed form, Discard is "drop the edits", and a save writes
    the server's response into the cache. `PUT /targets` returns no names, so the save merges the
    known names into the cached set rather than blanking them.
    **Topics and concepts closed it.** Topics are keyed per topic (`['topics', id, 'news']`...), which
    replaced the store's hand-written "drop a late answer for another topic" check; `TopicsStore`
    keeps `openTopicId`, the composer and the weak toggle, and reads the list through
    `topicsCache` because the composer's cap rules need it. Concepts are a query with
    `staleTime: Infinity` (a definition does not move with the market) that resolves a 404 as
    `null` - "not ingested here" is a state, never retried, never an error.

65. **Every view has an address: TanStack Router, routes in code** (`apps/web/src/router.tsx`). The
    user chose TanStack Router or React Router, Claude's pick (2026-09-29): TanStack Router, because
    it sits beside TanStack Query and is typed end to end. **Code-based routes, not file-based**: six
    routes do not need the Vite plugin's build step, and one file shows them all. `NavigationStore`
    is gone - the URL is the navigation state. The router renders only once the session is known,
    so a signed-out visit to `/settings` shows sign-in *at* `/settings` and lands there after. An
    unknown path renders the portfolio. Header and "Back" controls are `<Link>`s styled by
    `buttonClass()`, so they are real anchors (new tab, read as links). Both web servers already
    fall back to `index.html` - Vite in dev, nginx `try_files` in the prod image - so a reload deep
    in the app is served. **FR-21's link:** Telegram refuses a `127.0.0.1` URL button, so PR 9 added
    `/proposals/:id` and an optional `WEB_BASE_URL` (decision 69); it stays unset until M7 gives a
    public https address, and then messages carry the link. Tests render
    pages with `renderPage()` (a one-route router) because a page with a `Link` needs one.

66. **The equity curve draws stored snapshots only** (the user's decision, 2026-09-29):
    `lib/equityCurve.ts` makes one point per calendar day between the first and last snapshot,
    and a day with none is a gap, never interpolated or synthesised from quotes (which would be
    "today's holdings, backdated", not the account's history). A degraded snapshot is drawn hollow
    and named in the caption and tooltip, not hidden. Two series on one money axis: value in the
    accent `#6d8bff`, cost basis in olive `#8f9b2f` *and* dashed - the pair passed every check of
    the dataviz palette validator against the card surface `#131a2e`, where the app's grey failed
    (reads as no data) and its green/red are reserved for gain/loss. Every point has a dot,
    because a day between two gaps is otherwise a zero-length line. A table view carries the same
    figures. The data as of 2026-09-29: 9 snapshots over 16 days; the 14 Sep one is degraded
    (0 of 0 priced, yet a total), and value jumps 30% on 16 Sep, most likely real prices arriving
    (M2.5) - drawn as stored.

67. **A fixture price never stands in for a real one** (`app/providers/price_provenance.py`, found
    2026-09-29 while measuring history for the holding page). This machine's `.env` chain is
    `yfinance,fixture`, so whenever Yahoo failed the fixture provider answered - and the backfill
    stored its constant prices among real closes: 31 NVDA rows and 17 SAP.DE rows, e.g. $134.08 on
    Sat 12 Sep between real ~$218 closes. **On 2026-09-23 the drawdown rule reported "NVDA is -48.6%
    from its 30-day high" (high severity) from a fixture $118.45**; its Telegram send failed, so it
    was never pushed, but it is in the feed. Guideline 7 says an unavailable price is null. Now: a
    chain that does not *start* with `fixture` is a real installation, and it (a) never builds the
    fixture provider (`admissible_chain`, logged `providers.fixture_fallback_dropped` at startup),
    and (b) never reads stored fixture rows (`excluded_price_sources` -> `load_price_series`). A
    demo chain (`fixture,...`, `.env.example`, CI) is unchanged. The 48 rows were **filtered, not
    deleted**. The false finding and its failed notification row were **deleted at the user's
    request (2026-09-30)**, after #96 was live, and a manual `portfolio_scan` confirmed it did not
    return. Redis was checked: no fixture quote was cached.

68. **A holding's chart draws the rules' own series** (`/holdings/$holdingId`, PR 8, 2026-09-30).
    `GET /market/history/{instrument_id}` on the AI service returns `load_daily_closes` =
    `load_price_series` (fixture rows excluded, bounded above by now) + `normalise`; the orchestrator's
    `GET /holdings/:id/history` checks the holding is the user's and passes it through. Rejected:
    SQL in `queries.ts`, which would have been a second definition of "a day's close" and of "which
    sources are real", and the orchestrator does not know the provider chain. So the line a reader
    sees is the series a finding was computed from, by construction. Chart rules (`lib/priceChart.ts`):
    closed-market days are not gaps - a break only where closes are more than `MAX_CLOSED_DAYS` (5)
    apart, measured max was 4 (5 once on XETRA); today's point is labelled "so far today", because
    before the close it is the latest observation, not a close; the cost-per-unit line (olive, dashed,
    decision 66's pair) is drawn only when it falls inside the price range, else the legend says
    "below/above this range" - stretching the axis to NVDA's $98.75 under a $227 price flattened
    every move. Position figures are the cached portfolio row (no second request, so the page and
    the dashboard cannot disagree); findings come from `/observations?symbol=`, which matches both
    `instrument:X` and `portfolio:allocation:X`; news is `GET /holdings/:id/news`, newest 20 of the
    week with `total` ("newest 20 of 333") and the collection state, each article saying how it was
    matched ("matched by name “Nvidia”") because a name match is weaker evidence than a ticker.
    A stale link renders "No such holding" and asks for none of the three.

69. **The inbox shows every outcome, and each proposal has an address** (PR 9, 2026-09-30).
    `GET /proposals?state=history` lists approved, rejected **and expired**, newest decision
    first (20); "Just approved" above it holds only approvals Undo can still reach, and one moves to
    the history when its window closes. `/proposals/$proposalId` reads the unused `GET /proposals/:id`:
    an open proposal is decided there through the same `ProposalsStore` (one guard, one refusal
    path), a decided one shows its outcome, evidence and **audit trail in words**, and a 404 is
    "No such proposal" (resolved as `null`, never retried). Evidence goes through `readEvidence`
    (`EvidenceDrawer`, always open, before the buttons) instead of raw keys. **Weights are now a
    `share` unit - unsigned** ("Actual 35.16%", not "+35.16%", which read as a move); `drift` and
    `*_pct` stay signed changes; `target_weight_sum` is "All targets together". Outcome badges are
    accent / warn / muted, never green and red (decision 66 reserves those for gain and loss).
    **An expiry is dated by its deadline (`expiresAt`), never by `decidedAt`**: that is when the
    sweep recorded it, and measured over the 12 expired proposals the lag had a **median of 52 h**
    and a maximum of 4 d 15 h, because the sweep runs only while the stack is up. The trail says
    "recorded after its deadline passed" for the same reason. **FR-21:** optional `WEB_BASE_URL`
    adds an "Open in app" URL row to every Telegram proposal keyboard, decided ones included (the
    page is where the trail is). Only a public https origin is used (`proposalLinkBase`): Telegram
    refuses the *whole message* over an `http://` or private-host URL button, so a bad value is
    dropped with one startup warning rather than failing every alert. Unset here until M7.

70. **`/ask` has a screen, and every kind of reply looks different** (PR 10, queue task 6).
    `/ask`: a question box (Enter sends), three example questions that fill it but never send, and
    this session's questions newest first in `AskStore` - a reply is a one-off action's answer
    (decision 64's exception), not a resource to re-read, and re-asking can cost a minute. One
    question at a time. Kept apart on screen (decisions 32, 36): an answer; **a weak match**, with
    a page-level banner and the relevance score as well as the service's own hedge in the text; a
    computed answer with its figures (`EvidenceDrawer`); and **four refusals, each titled** -
    "Not in the reference corpus" (with the closest score), "No holdings to compute from" (with a
    way to add them), "No personal investment advice", "Not something I can compute" (with what
    can be) - and an unknown reason named as unknown, never folded into one of those. A failure to
    get any reply is an error with a retry, never a refusal. Every answer says who wrote it:
    quoted passages, a model's paragraph checked against them, or arithmetic no model touched -
    and, when a model's draft was set aside, why (`askPresentation.ts`). The "matched on shared
    words" note shows only for a concept answer on the fixture embedder; a portfolio answer
    searched nothing. Passages are shown verbatim through `ConceptText` (the corpus's markdown
    subset parsed into elements, now shared with the concept dialog). **The wait is part of the
    design:** the free route takes 18-69 s, so the waiting line counts seconds and says a model
    may take a minute or more. `readEvidence` reads a bare `weight` key as a share.

71. **The feed is a page, filtered in the address** (PR 11, 2026-09-30). `GET /observations` takes
    `severity` (at least: `notable` = notable and high), `symbol`, `before` (a cursor) and `limit`,
    and returns `total` (the filter's count) and `nextCursor` (null when there is no more - said by
    the server, from one row more than a page, never guessed from a short page). **The cursor is the
    id of the last finding shown**, and the next page continues after that row's `(created_at,
    severity rank, id)`, looked up in SQL: a timestamp cursor would fail, because `created_at` has
    microseconds a JavaScript `Date` drops and one scan's findings differ only there. **Ordering
    fix:** the tie-break was `severity DESC` on the *text*, so every multi-finding scan listed its
    high finding **last** ("notable" > "info" > "high") - measured on every tied scan in the data;
    now a rank CASE on `SEVERITY_RANK`'s scale (`notificationPolicy.ts`). The dashboard shows 10
    (`FEED_PAGE_SIZE`) with "Show N more"; filters live in its URL (`/?severity=high&symbol=NVDA`,
    `replace: true` - a filter is a view, not a place for Back), read loosely with `useSearch({
    strict: false })` and validated by `feedFiltersFrom`, because the same page renders for unknown
    addresses. A filter that matches nothing says so ("No findings match these filters"), never
    "Nothing to report". Refresh invalidates every filtered view (`['observations']` prefix).
    Measured effect: the dashboard **9,557 -> 3,284 px** at 1280 and **13,727 -> 5,043 px** at 375.

72. **On a phone the holdings are cards, chosen in JavaScript** (PR 12, 2026-09-30). Measured
    first, every page at 375 px: nothing overflowed the page, and only the dashboard had a problem -
    the holdings table was **880 px inside a 341 px box** (symbol, quantity and half a price
    visible) with **16 px** edit/remove icons, and the four summary cards stacked to ~390 px. Now
    `useNarrowViewport()` (`lib/viewport.ts`, Tailwind's `sm`) renders `HoldingCard`s below 640 px:
    value and P&L first, then quantity x price, today, weight and price age, then **40 px**
    "Quantity" and "Remove" buttons sharing `useHoldingEditor` with the table row, so the two cannot
    differ in what Save or Remove does. **Rejected: render both and hide one with CSS** - every
    holding twice in the DOM, and jsdom applies no Tailwind, so tests would find two of every link.
    Without `matchMedia` (jsdom) the answer is "not narrow" - the desktop layout the older tests
    describe; `holdingsNarrow.test.tsx` stubs it (and deletes it after, or every later test is a
    phone). Summary cards are 2x2 at every width below `lg`, the percentage on its own line.
    Measured after: summary 390 -> 192 px; the dashboard is **5,679 px** at 375 (5,043 before -
    readable cards are taller than a sideways-scrolling strip, deliberately); 1280 unchanged.

---

## Bugs that cost real time, and the lesson from each

**A looping model answer passed the evidence validator (found measuring `/ask` for its screen).**
The free route answered "what is the current price of gold" with "Hereellsellsellsell…" for most of
2,500 tokens, and `/ask` returned it as `answer_source: llm`: the validator checks *figures*, and the
loop's one figure was in the cited passage. 1 of 7 model answers measured that morning. Fix:
`app/llm/degenerate_text.py` (a unit of 1-10 characters containing a letter, repeated 8+ times in a
row) runs before the figure check; `/ask` falls back to the verbatim passages with
`fallback_reason: degenerate_completion`, and narration treats it as `malformed` (no new reason for
`narrationHealth.ts` to learn). Checked against every stored text first - 36 corpus chunks, 72
observations, 7,410 article titles - with no match. → **A validator that checks one property
(sourced numbers) is not a validator of the text.** Ask what else a bad output could look like and
still pass it; a model's failure modes are not limited to the one the check was written for.
Also measured then: the free route takes **18-69 s** per answer, once over 3 min (client timeout is
5 min); a refusal takes 0.6 s.

**A provider's daily history includes the day still trading, and the backfill kept it forever (#98).**
Yahoo returns today's candle while the session is open, priced at the latest trade, and the provider
dates every candle 20:00 UTC; the backfill inserted with `DO NOTHING`. So every backfill that ran
before a session closed stored the price at run time as that day's close, permanently: AAPL's 16 Sep
"close" was $332.57 (real $332.41, which the next morning's quote showed), every crypto close since
mid-September was the price at the hour the backfill ran, and a 06:45 UTC run wrote a BTC row dated
20:00 that evening. Found only because the holding page's measurement listed raw rows around "now".
Fix: never store a close dated after now; the backfill replaces its **own** earlier rows (same
source, `delay_seconds = 0`), never an observation. The next manual run corrected 18 rows, including
AAPL's to $332.41. → **When a provider's "daily" series is stored, ask what it returns for today.**
And `DO NOTHING` on a value that can legitimately change is a decision that the first answer wins;
make it deliberately.

**The equity curve was a day early on this machine and right in the container.** node-postgres
parses a `DATE` into a JS `Date` at *local* midnight; the snapshots route printed it with
`toISOString()`, which is UTC, so at UTC+3 `2026-09-14` became `2026-09-13`. The container runs in
UTC, so CI and the compose stack were right, and the route's own test mocked the row as
`new Date('2026-09-14T00:00:00Z')` - UTC midnight, the one input where the bug cannot show. Found
only because the chart's first tick said 13 Sep while the first snapshot was the 14th. Fixed by
selecting `as_of::text` (M6 equity-curve PR), pinned by an integration test that sets
`TZ=Asia/Jerusalem`. → **A calendar date must never become a `Date`.** Select it as text, and when
a test mocks a driver's value, mock what the *driver* returns, not what is convenient to write.

**A test that read the clock passed for a day, then failed on `main` and every PR.** `sendDigest`
called `gatherTopicDigest(user)` with no time, so it used the real clock, while its test pinned
rows to 2026-09-27. It went red at midnight, and a neighbouring test was one day from the same
fate. Found because two unrelated PRs failed the same check. → **A monkeypatch stopped patching anything, and the test started reading the clock.** A registry
test forced "market open" by patching `is_us_market_open`; #77 routed `quote_ttl` through a new
`is_session_open`, so the patch hit a function nobody called any more. #77's CI ran during US
hours and passed; the next run, overnight, failed on `main` for every PR. Found on a MEMORY-only
PR, which is what made it obviously not that PR's fault. → **After a refactor that reroutes a
call, grep the tests for `monkeypatch.setattr` on the old name.** And the clock lesson again, from
a new direction: a test that *forces* a condition is only as good as its hook into the code.

**0019 could not be re-applied after its own downgrade, and nothing had ever tried.** Its downgrade
keeps proposed and rejected auto topics (deliberately) and drops their fingerprint columns; its
upgrade then adds a CHECK that every auto topic has a fingerprint. So any rollback below 0019 with a
proposal present could never roll forward. Found on the Postgres job's first run, by stepping
each revision down *and back up* over data. Fixed in 0019's upgrade (backfill before the CHECK,
words by `matchWords`' rule frozen in the migration) - in the file that refuses, as with 0006. →
**A downgrade that keeps rows must be checked against its own upgrade's constraints**; the
round-trip test now does that for every revision.

**A race test passed with the lock it tested removed.** Five concurrent calls finished too fast to
overlap, so the test for `recordNarrationState`'s row lock was green either way. Ten rounds of
twelve overlap reliably (9-10 rows written without the lock). → **Run a concurrency test once with
the protection removed**; a race that never happens in the test proves nothing about the lock.

**A test must not read the clock,
any more than `.env` (CLAUDE.md convention 3): anything that decides "today" takes `now`.** The
check that proved nothing else did this: run each suite once with `Date` faked a year ahead
(`vi.useFakeTimers({ now, toFake: ['Date'] })` in a throwaway setup file) and read what breaks.

**The first real headlines broke three assumptions a green suite had passed.** Syndicated copies
counted as recurrence; unlinked articles read as themes; everyday words spent the resolve budget.
Every one was invisible on fixture data and obvious on the first real batch. → **Before calling a
data filter done, run it read-only over real data and read the output.** It took one query each
time.

**An illustrative number nearly became the design.** The instrument-overlap rule was chosen from an
example ("nuclear fuel" overlaps "uranium" by 80%) that nobody had measured. Five real resolutions
showed 0% on the confident sets the first version compared. → **Before building on an example
number, run the real thing once; the resolver is five embedding calls away.**

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

**Taps did nothing for a day, and every test was green.** M4 was verified with a hand-run script
that polled `getUpdates` and replayed each update at the webhook. The script was never committed, so
when its session ended the product lost its only inbound transport - and the webhook tests kept
passing, because they post to the handler directly. Nothing asserted that *something delivers*.
→ **Scaffolding that a verification depended on is part of the product until proven otherwise.**
If a feature only worked while a script was running, the script belongs in the repository.

**A migration number is a shared resource.** Two PRs in flight both took `0007` off `0006`, which
would have given Alembic two heads and broken `upgrade head` outright. Neither PR could see the
other.
→ **Check `alembic heads` returns exactly one before merging anything with a migration**, and
renumber the PR that is cheaper to move — the one not yet opened, not the one already in review.

**A parked branch's migration number went stale while it sat.** `claude/m3-corpus-concept-links`
was written carrying `0010_kb_corpus` off `0009_telegram_bindings`. While it waited, `main` took
the same parent for `0010_instrument_metadata` and then added `0011`. Merging it would have given
Alembic two heads and made `upgrade head` fail outright for every installation. MEMORY.md already
carried the remedy — "check `alembic heads` returns exactly one" — and it did not help, because an
instruction is only followed by sessions that read it, and this branch was written before the
instruction existed. The same collision had already been caught by hand once, when two M4 PRs both
took `0007`.
→ **A rule that has been broken twice belongs in a test, not in a document.**
`services/ai/tests/test_migration_chain_contract.py` now asserts the shape of the graph: no shared
parents, unique revisions, one base reachable from one head, and numeric prefixes sorting in chain
order. It was confirmed to fail against the original pair before being kept.
→ The general form: **a branch that sits still still rots**, because the numbers it reserved are
shared with everyone else. Rebase a parked branch onto `main` before reading a line of its code.

**A markdown subset was assumed rather than measured.** The concept text parser was written to
handle `**bold**` and indented formulas, because those are what the documents *appeared* to use.
The corpus also uses `*italic*` throughout — including in the three documents written two sessions
earlier — and every one of those would have rendered as literal asterisks to the reader. It was
found by grepping the nine files before writing the test that claimed they only used the supported
constructs.
→ **When you are about to assert something about data, read the data first.** The assertion was
about to be written as a fixture of what the documents were believed to contain, which is the same
shape as the M2 bug where templates were tested against hand-written evidence.
→ The test now reads the nine real files and fails if any emphasis marker survives into rendered
output. Confirmed failing for all nine against the bold-only parser.

**A nullable discriminator was read by a query that did not know about it.** The ingester's dry-run
selected every `kb_documents` row regardless of namespace. A `news` document carries a null
`concept_slug` by design, so it came back as an orphaned concept and crashed a sort comparing `str`
to `None`. `--prune` had the identical gap, which would have made "load the definitions" a command
that silently deletes ingested articles.
→ Found by *running it* with a news row present, not by a test — the hermetic Python suite has no
Postgres and cannot reach the SQL's scope. This is the same lesson as the three M4 bugs, arriving
again: **the suite cannot test the layer it is deliberately isolated from, so that layer has to be
exercised by hand or in the compose job.**

**A new data directory was not in the image, and the path that read it could not have worked
there.** `Dockerfile.ai` copied `data/fixtures` and not `data/corpus`, and the ingester's
repo-relative default (`parents[3]`) raises `IndexError` from `/app/scripts/`. Both would have
shipped: every unit test passes because it runs from a checkout, where both are fine.
→ **A path that resolves differently in a container needs the two-place resolution the codebase
already has**, not a repo-relative guess. `Settings.corpus_dir` now mirrors `fixtures_dir` exactly:
checkout path if it exists, container path otherwise, env var always wins.
→ CI now starts the `corpus` container and fails unless it exits cleanly, because that is the only
gate that can see either fault.

**A CI gate that could not have failed for the reason it claimed.** The new corpus check asserted
the container's state by grepping `docker compose ps --format '{{.State}}'` for `exited (0)`. That
string is in no field: `.State` prints `exited` with no code, `.Status` prints `Exited (0) 2
minutes ago` with a capital E, and only `.ExitCode` prints `0`. It failed on the first CI run while
the ingestion it was checking had worked perfectly — nine documents created inside the container
from the image.
→ The lesson is not "read the docs for `--format`". It is that **the evidence was already on
screen**: running that exact command locally had printed `exited`, and it was read without being
compared against the pattern just written. This is the third appearance of the same failure —
`grep -c "Done"` hiding a failing typecheck, container checks testing `main`, and now this.
**Reading a gate's output means comparing it to what the gate asserts, not glancing at it.**
→ It now compares a value (`.ExitCode` = `0`) rather than matching a substring, and an absent
container yields the empty string, which is not `0` — so a service that never ran fails instead of
passing vacuously. **A gate that cannot fail is worse than no gate**, because it is counted as
coverage.
→ And the process lesson: **exercise every branch of a check you add, not the one you expect.** All
three were run this time — clean exit, missing container, and a genuinely failing ingestion.
→ **Correction, M3 slice 4: that was three of four branches, and the fourth passed vacuously.** A
container that is *still running* reports `ExitCode` **`0`** — measured with a probe that slept and
then exited 3: `ExitCode='0' State='running'` mid-sleep. So this check passed whenever it read
mid-ingestion, which is precisely the failure this entry says it fixed. It never bit only because
fixture ingestion is fast. The obvious replacement, `docker compose wait`, is wrong the other way:
for a service that has *already* exited it prints "No containers for project" and returns 1, which
would have failed CI on nearly every run. `scripts/wait-for-exit.sh` polls `.State` until it reads
`exited` and only then trusts `.ExitCode`, and was run against all four states before being used.
**The lesson that generalises: "every branch" is a claim about the state space, and it is only as
good as the enumeration. Three was believed to be all of them.**

**Two retrieval bugs, both invisible to a hermetic suite, both found on the
first real query.** Slice 2's SQL was written, reviewed, and covered by 40 new
tests that all passed, and neither of these survived one second of contact with
Postgres.

- An optional parameter compared only against NULL — `(:model IS NULL OR
  c.embedding_model = :model)` — is rejected outright: `could not determine data
  type of parameter $3`. Postgres has nothing to infer the type from. The fix is
  a cast; the point is that the statement *never runs at all*, and nothing in
  the suite executes a statement.
- `plainto_tsquery` **ANDs** its terms, so "how do I bring my portfolio back to
  its target weights" becomes `bring & portfolio & back & target & weight` and
  requires one chunk to contain all five. Three of the four natural-language
  questions tried returned **nothing** from the full-text half. MEMORY.md's own
  claim that "the full-text half is real, which is why hybrid retrieval still
  gives a usable answer in the meantime" was therefore false as written: the
  half that was supposed to carry the placeholder period was silent for exactly
  the queries `/ask` exists to serve. The query is now rewritten to OR by
  rendering `plainto_tsquery`'s output and replacing its operator, so the
  parsing, stemming and quoting stay with Postgres and no user input is ever
  interpolated.

→ The lesson is not "write better SQL". It is that **the hermetic suite cannot
test the layer it is deliberately isolated from, and that layer is where the
bugs are** — this is now the third consecutive slice where running the thing
found what a full green gate did not. Budget the hand-exercise; it is not
optional polish.
→ And specifically: **a belief about retrieval quality written into MEMORY.md is
still a belief.** The AND semantics could have been checked in one `psql` line
at any point in the two sessions the claim sat there.

**"Blocked on X" was inherited for two sessions, and then disproved with the wrong
argument.** MEMORY.md recorded the paid embedder as blocked behind the same OpenRouter
spend cap as narration. Checking the price dissolved that: embedding the whole corpus is
5,114 tokens ≈ **$0.0001**, against narration's ~$0.45/month — four orders of magnitude
apart, filed under one sentence. So the migration was started on the strength of "it is
not actually blocked"; the first live call returned **403, budget already exceeded**. The
cap is a *lifetime* budget that was already spent, so the cost of the operation was never
the relevant number.
→ Two distinct lessons, and the second is the sharper one. **A constraint copied forward
is not a verified constraint** — that sentence sat unchallenged through two sessions and
one line of arithmetic moved it. And: **checking the price is not checking the balance.**
Having just criticised an inherited belief, the replacement belief was adopted with
exactly the same rigour it was accused of lacking. When correcting an assumption, verify
the *new* claim at least as hard as the one being discarded.
→ Practical form: `GET /api/v1/credits` reported `total_credits: 0` even *after* the
budget was raised and calls were succeeding. **The only reliable test of a paid endpoint
is a paid call.** One 5-token request costs $0.0000001 and answers definitively.

**Fusing a weak ranker with a strong one at equal weight made the strong one worse.**
Once the embedder became semantic, the ORed full-text half went from lifeline to liability:
over six paraphrased questions the vector half alone scored **5/6**, the lexical half
**2/6**, and RRF over both **4/6**. Reverting the lexical half to AND restored **5/6** —
because strict, it returns nothing rather than something plausible, and a half that
abstains cannot outvote a half that knows.
→ **The right strictness for one half is a function of what the other half can do**, so it
is passed in rather than configured: `require_all_terms=vector_is_semantic`. A weight
would have needed a number nobody could justify; a boolean derived from a property the
system already knows needs none.
→ The general form, and the reason this is written down: **a justification can expire.**
The OR rewrite was correct, measured, and documented with its reasoning — and that
reasoning ("the hybrid would be one placeholder embedder wearing two hats") became false
the moment the placeholder was replaced. Comments that record *why* are what make this
detectable; a comment that had only recorded *what* would have survived unchallenged.

**The eval set found three bugs on its first run, and two were predicted and still shipped
first.** "What will my portfolio be worth next year" contains "worth", so the total handler
answered a forecast with *today's* figure. "Should I sell my largest position" names the largest
position, so that handler answered with its value — dodging a request for advice silently instead
of declining it (guideline 2). Both were written into the eval *expecting* them to fail, and they
did; both are now refused before any handler runs. The third was the gold case above.
→ **Write the case for the bug you suspect before fixing it.** A fix with no failing case first
cannot show that it fixed anything, and an eval that has only ever passed has not yet been shown
to be able to fail.

**A metric improved because a case was relabelled.** Once the gold case expected "hedged" rather
than "refused", the threshold report stopped counting it as out-of-domain — and separation jumped
from +0.0667 to **+0.1404** with the floor reported "inside the gap". Nothing about retrieval had
changed. Cases now carry `out_of_domain` for what they *are*, independent of what is expected of
them, and the report is back to the true figure.
→ **What a case is must not change because what we do about it changed.** Otherwise every
decision to accept a behaviour also quietly improves the measurement of it.

**First person does not mean "about my portfolio", and the obvious router ships that
bug.** Keying intent on "my"/"I" fails immediately on *"how much did I lose from the
top"* — first-person, and a **concept** question about drawdown. So is "should I sell
when things drop". What separates the two is a reference to their *holdings*, not to
them.
→ **Pronouns describe how someone writes, not what they are asking about.**

**A word boundary does not make a ticker unambiguous.** The symbol matcher was written
as `\bSO\b` with a comment claiming it stopped Southern Company firing on the word
"so". It does not — `\bso\b` matches "so" perfectly well, and a test written to check
the comment failed on the first run. Tickers are conventionally upper case, so the match
is now **case-sensitive against the original question**, and a lowercase "aapl" falls
through to CONCEPT (the harmless direction).
→ **A comment asserting a property is not the property.** This one was written,
believed, and disproved by the test that was written to confirm it — which is the whole
argument for writing the test.

**The evidence validator caught a derived figure in a template, not a model.** "This
excludes **1** unpriced holding" — the 1 is `holdings_count - priced_count`, computed in
the sentence and absent from the evidence. The validator rejected it exactly as it
rejects a model's invention.
→ **The validator is not an LLM guard, it is a provenance check**, and it is worth
pointing at deterministic text too. A figure the reader cannot trace is untraceable
whoever wrote it.

**The compose gate was counted as coverage for `/ask` and never called it.** Slice 3's
PR went up green with "the compose smoke test passes" as part of its evidence.
`scripts/smoke-test.sh` exercised the M1 vertical slice and nothing since — not `/ask`,
not even `/concepts/:slug` from slice 1. Adding the checks then found two more things: a
Python f-string with escaped quotes in its expression, which is a `SyntaxError` before
3.12 and would have failed on the host's 3.9 — and that the `not_in_corpus` refusal
**cannot be asserted in CI at all**, which MEMORY.md had just claimed the eval set could
measure.
→ **Before citing a gate as evidence, check what it runs.** Green means "every check
that exists passed", and says nothing about checks that do not exist.
→ Every new check was then fed bad input to prove it could fail — six assertions, all
failing as they should. A check that has only ever passed has not yet been shown to be
a check.

**The smoke test replaces every holding in the database it points at.** It imports with
`mode: "replace"`. Running it against the shared dev stack deleted and rewrote the
portfolio — harmless *this time*, because that database already held the demo portfolio,
which was confirmed afterwards by reconciling against the last snapshot to the cent. But
it was confirmed afterwards rather than checked before. The script header now says so in
capitals.
→ **Read what a script writes before running it against data you did not create.** The
reconciliation also carried its own trap: a naive cost-basis sum was $504.93 short, and
the entire gap was SAP.DE's euro cost basis converted at EUR/USD 1.1465 by the snapshot
and not by the query. A mixed-currency sum is not a total (guideline 3), and an alarming
discrepancy should be checked for that first.

**A stale placeholder in `.env.example` became a boot failure.** M0 wrote an
`EMBEDDINGS_PROVIDER=fastembed` block with a 384-wide model, two milestones
before anything read it, and every local `.env` copied it. Slice 2's factory
refuses an unknown provider by design, so those installations would have met
"not a known embedder" on upgrade — a message that reads like a typo the reader
did not make. `fastembed` is now named explicitly and answered with "this is an
M0 placeholder, set `fixture`".
→ **A setting written before anything reads it is a guess that will be found by
the code that finally reads it.** Prefer adding configuration with its consumer.
→ `EMBEDDINGS_DIM` was deleted rather than honoured: the width is fixed by the
column, so an env var appearing to change it is a lie about what is
configurable.

**A fixture that looked like a solved problem.** The synthetic price history made the analysis
engine testable and also let the missing `history()` survive two milestones. A fixture hides an
absence.
→ When a fixture stands in for a real source, **record what is still missing** rather than treating
the green test as coverage.

**A renamed migration was verified by reading the working tree, and CI tested the commit.** Another
session renumbered `0014_instrument_profiles` → `0015` to follow #49's `0014_intent_revocation`. Its
commit was a *pure rename* (0 lines changed); the edited `revision`/`down_revision` were left
uncommitted in the worktree. This session "verified" the renumbering by reading the file on disk,
said it was correct, and CI failed with two Alembic heads.
→ **Verify a commit with `git show <sha>:<path>`, or in a clean `git worktree add --detach` of it —
never by reading the working tree.** "Verify by content" (the stacked-PR lesson) only works if the
content you read is the content that ships.
→ A peer session's "nothing uncommitted was touched" is a claim, not a check.

**The same gate-that-cannot-fail, a fourth time.** `ruff format --check . | tail -1` exits with
`tail`'s status, so a failing format check let a commit through. It was caught only because the
output line was read. → **Never pipe a gate into `tail`/`grep` inside an `&&` chain.** Run it bare,
or `set -o pipefail`.

**A failed fetch cached as "no data" would have become a fact.** The first universe build cached
`{}` for 41 symbols Yahoo rate-limited — including **GOOGL**, which two eval cases expect; it would
have looked like a resolver miss. Now a failure is not cached and the build refuses to write a
snapshot with holes. The mirror case arrived in slice 2: Yahoo's "No Fund data found" for an ETN
*is* an answer (no holdings) and raises the same exception type as a transient error, so the
message decides.
→ **Absence and failure must never share a representation** — the `null`-price rule, again, for a
cache.

**A scripted string replacement silently did nothing.** An edit to the holdings fetch matched text
the formatter had already re-wrapped; the constant it added landed, the `except` branch did not, and
the build failed the same way again. → When editing by script, **assert each anchor matched
exactly once**; a replacement that finds nothing is not an error in Python.

**Tuned gains did not generalise, and only the sealed batch could show it.** Slice 2 took the
primary suite from 5/20 to 9/20. On the sealed batch it changed nothing — 1/11 and 14/35 for both
slices. Every design choice after the first run had been made while looking at the primary suite.
→ **An eval you have looked at is a development set.** Keep a batch sealed until a change is final,
and treat the unsealed number as the result.

**CHECK constraints written from assumption were corrected by data — the right way round.**
`weight <= 1` rejected a leveraged fund's 106% position and a reporting error at 66,880%; the load
ran in one transaction and rolled back cleanly. The fix was to skip and count such rows, not to
loosen the column. Same lesson as 0006's `runs_kind_check`: **a constraint is only exercised by
data**, and it is better met here than in production.

---

**A layer with no caller is not done, and a green suite cannot say so.** M2 built and tested the
whole news pipeline; nothing ever called it, so `articles` was empty in every installation for three
milestones, and M5's plan assumed news existed. The same session found topic instruments had no
price history, because backfill read holdings only. Both were found in the first ten minutes of
topicScan by asking "what writes the table this reads?" and grepping for callers.
→ **Before building on a layer, grep for its callers and look at its table's row count.** "It has
tests" and "it runs" are different claims.

**GDELT's 429 was blamed on us for a whole handoff, and it was not ours.** Slice C saw 429s after
two quick curls and concluded the IP was throttled and would recover. It never recovered, and the
theory went untested because it was never framed so it could fail. The test took four requests:
the scheduler's requests were already 30 min apart and still refused; spaced probes 20 s apart
were refused with or without OR terms, `sourcelang` or a large window; one plain query succeeded
and the identical URL was refused two minutes later. A limit that depends on neither our rate
nor our request is the server's load, not our counter. → **Before explaining a failure by our own
behaviour, vary that behaviour and check that the failure moves with it.** Spacing probes
beyond the stated limit (20 s against a 5 s limit) is safe and is how to do it.

## Current technical debt

| Item | Where | Impact |
|---|---|---|
| **Telegram's inbound delivery is unproven** | deployment | Everything else was exercised against a real bot, but `setWebhook` needs a public HTTPS URL. The handler has only ever been driven by replaying genuine payloads at it locally. **The first real deployment is the first real test of that leg** — check `getWebhookInfo` for `last_error_message` immediately after |
| **`queries.ts` conflicts on every parallel PR** | `src/db/queries.ts` | Four M4 PRs appended a section to the end of one 1,200-line file, and every rebase put a conflict marker exactly where one function's closing brace met the next block's header — the brace was lost and hand-repaired **three separate times**. It is the cost of CLAUDE.md's "all SQL in one file" rule, which is otherwise good. Worth deciding whether to split by domain with an index |
| **Migration 0008 hard-codes a table Mastra owns** | `0008_mastra_workflow_state.py` | The library would create `mastra_workflow_snapshot` itself; Alembic creates it instead (`disableInit: true`), because CLAUDE.md says the AI service owns the schema. An upgrade that changes the shape breaks suspended runs — so `test/mastraSchemaOwnership.test.ts` compares the migration against `WorkflowsPG.getExportDDL()` and fails the build first. Two other things cost time to find: `PostgresStore` creates **43** tables for 24 storage domains unless you route only `workflows`, and `@mastra/core` posts feature-usage telemetry to PostHog unless `MASTRA_TELEMETRY_DISABLED` is set (it is, in `workflowRuntime.ts`, in code rather than `.env`) |
| ~~Concept chips point nowhere~~ | — | **Resolved in M3 slice 1.** Kept as a line rather than deleted because it stood here from M2 to M4 and its absence would otherwise read as an oversight |
| ~~Retrieval is exact-match only~~ | — | **Resolved in M3 slice 2.** Hybrid retrieval exists and `GET /concepts/search` serves it. What is still missing is the *answer*: there is no `/ask`, no intent routing, no citations and no relevance floor, so a nonsense query still returns the three least-bad chunks rather than a refusal. That is slice 3 |
| ~~No test executes a line of retrieval SQL~~ | — | **Resolved** (independent task 4): the `postgres (integration)` CI job - see "Orientation". It found a real bug on its first run: 0019's upgrade could not follow its own downgrade (below) |
| ~~OWED: migrate the fixture embedder to a paid OpenRouter embeddings model~~ | — | **Done.** `openai/text-embedding-3-small` through OpenRouter, verified against the live endpoint: 36 chunks, 5,114 tokens, **$0.00010228**, no chunk id moved. Set `EMBEDDINGS_PROVIDER=openrouter` to use it; the code default stays `fixture` so CI and a fresh clone remain keyless. The fixture was **not** deleted — it is the hermetic CI path and slice 4's eval set needs it |
| **The relevance floor is measured to be in the wrong place** | `app/ask/relevance.py` | `REFUSE_BELOW = 0.23` was fitted to sixteen questions. On the eval's held-out questions the classes separate at **(0.2502, 0.3169]**, so 0.23 sits *outside* the gap — and every keyed CI run prints that verdict. It was deliberately **not** moved: combined with the fitting set the classes overlap (0.2498 vs 0.2502), and a value chosen to make the held-out set pass would make it a training set. The hedged weak answer (decision 36) is what covers the boundary meanwhile. **The honest next step is more questions, written by someone who has not read the corpus**, not a new number |
| **The keyed eval tier does nothing until a secret exists** | GitHub repo settings | The `eval-keyed` job skips with a notice unless `OPENROUTER_API_KEY` is a repository secret. **Until it is added, nothing automated tests the `not_in_corpus` refusal** — the one M3's exit criterion names — because the floor abstains on the fixture path. Adding the secret is a settings change only a repo admin can make; it was deliberately not done from a session |
| ~~`/ask` has no user interface~~ | — | **Resolved in M6 PR 10** (decision 70): `/ask` in the web app, linked from the dashboard header. Kept as a line because it stood here from M3 to M6 |
| ~~`narration/templates.py` divides money by 100 unconditionally~~ | — | **Resolved** (independent task 1): templates render minor units at the currency's exponent (`minor_unit_exponent`), and **the evidence validator had the same assumption** - it divided every `_minor` figure by 100, so it would have *approved* "150.00" for 15000 JPY. It now reads the `currency` declared by each evidence mapping. The old template and old validator agreed on the wrong number, which is why no test saw it; the rule-output tests now run in JPY as well as USD |
| **The corpus is a derived copy that three separate mechanisms keep in step** | `data/corpus`, compose, `.claude` | The files are the source of truth and `kb_documents`/`kb_chunks` are what the API serves. A hook covers Claude's edits, the `corpus` container covers every stack start, CI covers the image. None of the three covers a hand edit on a machine with no stack running — that reader sees stale text with nothing reporting the disagreement. `--dry-run` answers "are they in step?" and nobody is obliged to run it |
| **The ingest hook does not apply to a session started before it existed** | `.claude/settings.json` | The settings watcher only watches directories that had a settings file when the session began, and `.claude/` had none. Any session started after that commit picks it up; the session that wrote it did not, and confirmed so with a sentinel rather than assuming |
| **Import previews live in process memory** | `services/previewStore.ts` | Forces `replicas: 1` in Kubernetes. The only remaining in-memory state — run keys moved to the `runs` table in M2 |
| **Templates are the deliberate steady state until deployment** (decided 2026-09-23) — funding narration was considered and **declined for now**, to be revisited when the product is deployed for real. So a future session should *not* treat template-only explanations as a defect to fix: the cost is known ($0.45/month), the fix is known (raise the OpenRouter workspace cap, point `LLM_MODEL` at a capable model), and the decision is to wait. | `.env` | Explanations are fixed phrasing over checked figures, and the dashboard badge says so |
| **The free tier cannot narrate at all, and the reason is not cost** | `.env`, `app/llm` | `LLM_MODEL` is a `:free` route because the OpenRouter workspace has a **lifetime** budget of $0.01 — a cumulative cap, not an allowance, so nothing resets and only an org admin changes it. On the free model narration now reaches the evidence validator and is **rejected every time** (`unsourced_figures`, 3/3 measured) for deriving figures not in the evidence. So free means templates, reliably. Real usage is ~$0.0015 per narration and ~10 findings a day ≈ **$0.45/month**, which is what funding the workspace costs. The badge (#38) states this to the user rather than hiding it |
| ~~Crypto detection is a symbol-shape heuristic~~ | — | **Resolved** (independent task 5): the quote request carries each symbol's `asset_class`; the `-USD` suffix is only the fallback for a bare lookup with no class |
| ~~Market hours assume US sessions for every symbol~~ | — | **Resolved** (independent task 5): `app/core/market_sessions.py` maps exchanges - display names *and* Yahoo codes, both present in `instruments` - to their own session in their own timezone; an unknown exchange keeps New York hours. Holidays, auctions and lunch breaks are still ignored, deliberately |
| ~~Server state is hand-fetched in every MobX store~~ | — | **Resolved in M6** (decision 64, #90-#92 and the topics PR): every read is a TanStack Query query, and no store holds a copy of a server response it must remember to refresh. What stores still call is writes (which update or invalidate the cache), the session check (changed only by the store's own sign-in and sign-out), and responses to one-off actions - an import preview, a topic resolution for the label being typed, the Telegram connect link - none of which is a resource to refresh |
| ~~The Topics screen has never been looked at in a browser~~ | — | **Resolved** (independent task 3, 2026-09-28): reviewed at desktop and 375 px against the live stack - the list, a topic card, and the confirm screen over a real 13-candidate resolution. Two faults found and fixed: the dashboard header did not wrap, so on a phone the page was 721 px wide and a tap on "Topics" landed on "Settings" (the only way to reach the page); and each candidate's checkbox was centred in its row, so on long quotes it sat beside the quote rather than the ticker it ticks. "Suggested from the news" was seen with real proposals on 2026-09-29 (#86), including the weak-match toggle; not yet at 375 px. Timestamps use the browser locale app-wide (`formatExactTime`); that is M6 polish, not a Topics fault |
| **Few component/DOM tests on the web app** | `apps/web/test` | Started with the TanStack Query foundation: `test/serverStateHarness.tsx` renders with a real query client and root store and only `api` mocked; a `.tsx` test opts into jsdom with `// @vitest-environment jsdom`, so the store tests stay in node. Rendered so far: the feed's four states, the holding writes, the Telegram card, the live inbox's interval, the topic card (`feed`, `holdings`, `telegramConnect`, `inboxRefresh`, `topicCard` `.test.tsx`). Earlier lesson kept: two UI bugs (Discard disabled by its own typo, a deep link that did nothing) were found by using the app, and a DOM test would have caught the first |
| ~~Telegram has no working binding~~ | — | **Resolved 2026-09-24.** A chat is bound. The "receives nothing" mystery was never a Telegram problem: nothing in the repository consumed updates, because M4's polling bridge was a hand-run script that left with its session. Kept as a line so the history of the symptom survives |
| **Real news needs `NEWS_PROVIDERS=gdelt,fixture` in `.env`** | `.env` | Slice C added the GDELT provider; the code default and `.env.example` stay `fixture` so CI is offline (the same deliberate asymmetry as `MARKET_DATA_PROVIDERS`). Until `.env` names `gdelt`, every live `news_collect` run fetches 0. **Also still unwired:** the narration correlation step - `run_portfolio_scan` is always called with `articles=()`, so no observation cites news yet |
| ~~Auto-discovery has run once on real, title-matched headlines and proposed nothing~~ | — | **Resolved 2026-09-29** by the market feed (decision 60): the first run over it proposed "data center" and "bond yields". The original text follows because its lesson (resolve budget spent on everyday words) still shapes `GENERIC_WORDS` |
| (history) Auto-discovery's first real run | `app/topics/discovery.py`, `services/topicDiscovery.ts` | 2026-09-28 10:33 UTC: 123 linked headlines, 20 phrases, 8 resolved, 0 proposed. Every resolved phrase was `none` or `weak` (`ai`, `buy`, `pro`, `prediction` none; `tv`, `crypto`, `iphone`, `remittix` weak). The 12 skipped by the 8-per-run cap were resolved by hand afterwards and none would have qualified either (`chips` resolves to potato-chip makers LW and UTZ; `futures` is `confident` with no confident candidate; `bytedance alibaba` is `weak` over NVDA/TSM/MU). **So 0 proposals was the right answer, and the run exposed two faults:** (1) the resolve budget went to everyday words - `buy`, `pro`, `use`, `billion`, `season`, `prediction` belong in `GENERIC_WORDS`; (2) single words are poor resolver queries (two-letter "ai" resolves to nothing), and the one multi-word phrase was the one with a real signal. Not yet shown: discovery *finding* a theme, which M5's exit criterion needs |
| ~~Open proposals never expire~~ | — | **Resolved** (decision 57, migration 0021): unanswered for `TOPIC_PROPOSAL_TTL_DAYS`, a proposal becomes `expired`, kept and named in the run's stats. Kept as a line so the history survives |
| **One standing drift is proposed again every day** | `services/proposals.ts`, observation `dedupe_key` | A proposal is deduplicated by its observation, and an allocation-drift observation's `dedupe_key` changes with each day's valuation. So a drift nobody has fixed becomes a new proposal daily: on 2026-09-29 the inbox held **two open BTC-USD drift proposals** (created 09-28 16:12 and 09-29 05:20 UTC) asking the same question, and one approved on 09-26 was followed by a new one the next day. Seen in the M6 browser review; **the user decided (2026-09-29) to record it and not fix it in M6**. A fix belongs in the proposal layer (one open proposal per subject and kind), not in the observation key, which is right to change daily |
| **An equity can have a weekend "close"** | `normalise`, the quote path | A dashboard opened on Sunday 27 Sep stored each equity's Friday price with a Sunday `as_of` (the provider's `fast_info` has no timestamp, so a quote is dated when it was fetched). `normalise` makes it a Sunday close equal to Friday's: a 0% day for the rules, a flat step on the holding chart. One day so far. A fix belongs in the quote path (do not store a quote for an exchange outside its session, `market_sessions.py` knows the sessions), not in the chart, which draws what the rules read |
| **Company names that are everyday words link falsely** | `app/news/entities.py` | Measured on the first raw-file run (2026-09-27 19:35 UTC): 2 of 18 stored articles were about the fruit - "Apple Cider & Donut Day at the Kinney Pioneer Museum", "Czipar's annual Apple Festival" - and linked to AAPL, because a capitalised "Apple" in a headline matches the company. The same will happen for "Target", "Block", "Visa", "Shell" when followed - and for **surnames**: on 2026-09-29 the "gasoline" topic card showed "Auxiliary Bishop René Valero and His Legacy" (thetablet.org) linked to VLO. Consequences: the fruit lands on the topic card and in sentiment, and discovery reads it ("festival" was a candidate phrase on 2026-09-28). The provider is not at fault; the matcher accepts a bare name as a sole signal. **Deferred by the user to a dedicated PR after more data** - likely shape: for a name that is also a dictionary word, require a second signal (a ticker, "Inc", a product word) before linking, and measure precision over several days of runs, not one |
| **Laptop sleep leaves gaps in collection** | local scheduler | Overnight 2026-09-27/28 the runs jumped 20:30 -> 23:13 -> 03:21 -> 10:18 UTC. The cursor caught up (16 files a run, never older than 48 h), so no news was lost - but the daily `topic_discovery` meant for local midnight ran at 10:33 UTC. Harmless for news; worth knowing when a "nightly" result appears at breakfast. M7's CronJob removes it |
| **Names ending in ", LP" never link to news** | `app/news/entities.py` `core_name` | `core_name` strips "Fund", "Inc" and the like but not a trailing ", LP", so "United States Gasoline Fund, LP" is matched - and searched on GDELT - only by that exact phrase, which prose never writes. **Not fixed on purpose:** 37 instruments in the committed universe have LP names, and `core_name` also shapes the resolver's matching text (`app/universe/matching_text.py`), so the fix moves topic resolution and needs the new held-out batch to measure. Fix both together, or give the news matcher its own rule |
| **A very large instrument list outruns the collect timeout** | `app/news/gdelt.py` | 8 names per request, 5.5 s apart: 500 instruments (the request cap) is ~63 requests, ~6 min, over the 5-minute `SCAN_TIMEOUT_MS`. Irrelevant at a dozen instruments; the fix when it matters is fewer, wider requests or a per-run instrument budget - **and retries shorten the headroom**: worst case per request is three 30 s timeouts plus 40 s of backoff (~130 s), so even today's dozen instruments (two requests) could need ~260 s of the 300 s budget. That worst case needs GDELT to time out rather than refuse, and refusals so far have taken 11-15 s |
| Redis cold start refetches everything | `core/cache.py` | The `quotes` table holds usable recent prices; warming from it was deferred |
| `instruments`, `quotes` and the news tables (and `instrument_profiles`, `etf_holdings`) have no `user_id` | migrations | **Intentional** — shared reference and market data, not user-owned. Documented so an audit does not re-flag it |
| **Topic resolution finds 14/35 expected tickers on held-out topics** | `app/topics/resolution.py` | Measured on the user's sealed batch; slice 2 did not change it. Causes, measured: one outlier sets the gate; no ETF clears the source floor for cloud/e-commerce/obesity/robot surgery; giants are described too broadly; OTC-only ADRs (LVMUY) are not in the universe. The backlog, ranked, is `docs/TOPIC_RESOLUTION.md` §4 — **and it needs a new held-out batch before any of it can be measured** |
| ~~The universe is not reachable from the running stack~~ | — | **Resolved in M5 slice 3** (`POST /topics/resolve`). The image copies `data/universe` without the descriptions; the compose `universe` container loads it on every start from a read-only mount of the checkout. CI loads hand-written fixture descriptions so the smoke test runs the resolver's SQL. **Still true:** nothing refreshes the snapshot itself, and a machine with no `descriptions.local.jsonl` answers `unavailable`, by design |
| **A fresh machine needs ~1 h of Yahoo fetching before topics resolve** | `build_instrument_universe.py` | Descriptions are not committed (decision 40). The build is resumable (`--cache`, `--holdings-cache`) and refuses to write a snapshot with holes; rate-limit failures are retried on the next run. Rebuilding also re-screens, so membership near the $1B line moves (LAC sits at $1.05B) |
| **Disambiguation is built and dormant** | `app/topics/meanings.py` | `MEANINGS_SPLIT_BELOW` was fitted before name stripping; afterwards no fitting topic splits, including "chips" and "mining". The code and its constant say so. Needs genuinely ambiguous fitting topics on current vectors before it is trusted |
| **Ticker networks still reach discovery through the followed feed** | `app/news/gdelt.py`, `market_feed.py` | `EXCLUDED_OUTLETS` applies to the market filter only (decision 60, deliberately: it did not change what the followed feed collects). But a network headline that names a followed company ("Nvidia (NASDAQ:NVDA) short interest...") is still collected and read by discovery, and on 2026-09-29 it produced a **weak proposal, "short interest"** (IWM, IWR, LQD...). Options: exclude the listed outlets from the followed feed too (changes topic news for the user - ask), or add "short interest"-style template words to `GENERIC_WORDS`. Measure on the stored window first |
| **The resolver cannot match events about private companies** | `app/topics/resolution.py` | "anthropic ipo" is a real, recurring story; it resolves `weak` to LLY, ABBV, PLTR - nothing to do with it - because Anthropic is not listed. Weak proposals are hidden by default exactly for this (decision 62), but the band does not say *why* the match is weak. A resolver change needs the new held-out batch (batch 3) |
| **The discovery window only started filling with market news on 2026-09-29** | data | The 7-day window held ~150 market headlines on the first run, ~1,600 the same afternoon. Expect the proposals to change over the first week as it fills - more themes, and stronger counts behind them. Do not tune anything on the first days' runs |
| **The outlet-country table is from 2018** | `data/outlets` | 98% of the measured week's market articles came from a listed outlet; newer outlets have no country and count against a phrase's lead country (errs towards keeping it). Rebuild instructions are in its README; re-measure the 0.75 bar after replacing it |
| **The market feed stops when the user follows nothing** | `routes/internal.ts` `news_collect` | The run is skipped with "no holdings and no topics", and the market feed rides on it. Harmless in v1 (there are always holdings); relevant the day an empty account is supported |
| **The topic eval is not in CI** | `scripts/run_topic_eval.py` | Needs a database holding the universe *and* a semantic embedder; CI has neither. `test_topic_eval_set_contract.py` guards the file on every PR, but no automated run measures resolution

---

## Local environment (this machine)

- **`.env` has `MARKET_DATA_PROVIDERS=yfinance,fixture`** — real, 15-minute-delayed prices. Since
  decision 67 the trailing `fixture` is dropped at startup (a real chain never falls back to invented
  prices), so this is effectively `yfinance`: a Yahoo failure now leaves a holding unpriced.
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
  while the images still held 0009. **This recurred in M3 and will recur again**: applying
  `0012_kb_corpus` natively put the DB ahead of a `migrate` image still built from `main`, and the
  container died with `Can't locate revision '0012_kb_corpus'`. The fix is always the same —
  rebuild the image (`docker compose build migrate`), not touch the database.
- **The database currently holds the ingested corpus**: 9 documents and 36 chunks in
  `kb_documents` / `kb_chunks`, **all 36 embedded by `openai/text-embedding-3-small`**.
  Switching `EMBEDDINGS_PROVIDER` re-embeds on the next ingest and moves no chunk id,
  because the model is recorded per row. A fresh database needs
  `scripts/ingest_corpus.py` or a stack start, or every concept chip 404s and every search returns
  nothing. `--dry-run` says whether the files and the database agree without writing, and now
  reports embedding coverage as well as text — vectors are a second derived copy with the same
  drift.
- **As of 2026-09-29 05:25 UTC the stack runs `main` at #77 (`7752018`) and the database is at
  `0022_narration_transitions`**, rebuilt with `bash scripts/dev-docker.sh` (no `--reset`), and checked
  inside the containers rather than assumed. **`.env` has `NEWS_PROVIDERS=gdelt,fixture`** (the
  user's choice; `.env.example` keeps `fixture` - a deliberate asymmetry, do not "fix" it), which
  now means GDELT's raw files: about 96 downloads and **~300 MB a day** from
  `data.gdeltproject.org`. `articles` holds real, title-matched news from 2026-09-27 17:45 UTC on,
  plus 77 unlinked articles from the old search API that age out of every 7-day window by
  2026-10-04 (left in place by the user's decision; discovery ignores unlinked articles).
- **After a merge, the stack is not updated by itself.** Two steps, both needed: fast-forward the
  main checkout (`cd /Users/a/projects/Traders && git merge --ff-only origin/main` - compose builds
  from there, never from a worktree), then `bash scripts/dev-docker.sh`. Confirm by grepping the
  running container, e.g. `docker exec traders-ai-service-1 grep -c <marker> /app/app/...`; the
  orchestrator image runs its TypeScript source under `/repo/apps/orchestrator/src`.
- **Port 8081 is held by another worktree's orchestrator** (`m3-slice-2`, found 2026-09-27), and
  answers `/healthz` - so a "server is up" check on 8081 passes against the wrong code. Run a
  branch's orchestrator on 8083, with `SCHEDULER_ENABLED=false TELEGRAM_UPDATES=off` so it cannot
  double-fire runs or steal the container's Telegram updates.
- **The stack and the database are in step as of 2026-09-24**: both at `0013_kb_embeddings`,
  images rebuilt from `main` at #47 with `bash scripts/dev-docker.sh` (no `--reset`, so the
  Postgres volume and every holding, quote and observation were kept). Verified rather than
  assumed: `migrate` and `corpus` both exited 0, and the keyed eval run *inside the running
  container* passed 35/35. They will drift apart again the next time a worktree applies a
  migration natively — see the shared-database bullet above for the symptom and the fix.
- **`.env` must set `EMBEDDINGS_PROVIDER=openrouter`** to get semantic retrieval; the code
  default is `fixture` and stays that way so CI and a fresh clone need no key. This is a
  deliberate `.env` / `.env.example` asymmetry, like `MARKET_DATA_PROVIDERS` above — do not
  "fix" it. **This machine's `.env` is already correct** (fixed 2026-09-24; the pre-edit copy
  was backed up outside the repository). Any *other* `.env` written from the M0 example still
  carries `EMBEDDINGS_PROVIDER=fastembed`, `EMBEDDINGS_MODEL=BAAI/bge-small-en-v1.5` and
  `EMBEDDINGS_DIM=384`: delete the last two and set the provider. `fastembed` names an adapter
  nobody wrote, and the service refuses to start on it, deliberately and with a message saying
  what to set. Leaving the bge `EMBEDDINGS_MODEL` in place is the quieter trap — the real
  embedder would ask for a 384-wide model and fail its width check on the first call.
- **The OpenRouter workspace now has budget**, which also unblocks narration (~$0.45/month) —
  the dashboard badge still reports templates, and whether that is still the right steady
  state is now a measurement nobody has taken rather than a constraint. `LLM_MODEL` is also
  no longer the route MEMORY.md measured as 3/3 rejected, so that finding may not apply.
- **`DATABASE_URL` in `.env` names the compose hostname `postgres`, which does not resolve on the
  host.** Anything run natively against the dev database needs
  `DATABASE_URL=postgresql://traders:traders@127.0.0.1:55432/traders` in front of it. This costs a
  confusing `failed to resolve host 'postgres'` every time it is forgotten, including to alembic.
- **`docker compose` builds from the main checkout, never from a worktree.** `REPO_ROOT` resolves to
  the script's own repo and the compose context is `/Users/a/projects/Traders`, so rebuilding while
  working in a worktree silently tests `main`. Several "fix confirmed" results this session were
  actually confirming unmodified code. To exercise a branch end to end, run the three processes from
  the worktree instead — AI service on `:8002`, orchestrator on `:8081` (`ORCHESTRATOR_PORT`, not
  `PORT`), web dev server on `:5179` with `VITE_API_BASE_URL` pointing at the orchestrator, and
  `ALLOWED_ORIGINS` set to that web origin or CORS refuses every state-changing request.
- **The main checkout is not pulled automatically.** It sat on `a0637be` for three merged PRs, which
  is what made the compose images stale. Pull it before rebuilding anything.
- **`psql` is not installed on this machine.** Use `docker exec traders-postgres-1 psql -U traders
  -d traders -c '...'`. So is `timeout(1)` absent; the Bash tool's own timeout is the substitute.
- **An `ai.openclaw.gateway` LaunchAgent runs permanently on this machine** with a Telegram connector
  bound to bot `8778977785` — *not* ours. It is unrelated, and it is recorded here so the next
  session does not spend an hour suspecting it of eating updates, as this one did.
- **A real Telegram bot is configured**: `@trade_pulse_agent_bot`. `.env` holds its token, its
  username and the two secrets. The bot is live — anyone with that token controls it; `/revoke` in
  BotFather if it ever leaks.
- **No webhook is registered**, and `TELEGRAM_UPDATES=polling` (the default) makes the orchestrator
  long-poll instead. Telegram serves one transport at a time: registering a webhook makes polling
  answer 409, which the poller logs as a misconfiguration. Only one process may poll a token -
  a second poller (another worktree's stack, a script) silently steals updates.
- **Tapping "Approve" in the real chat is the only end-to-end test of the Telegram leg.** The unit
  suite replays recorded payloads and cannot tell you that nothing is listening.
- Telegram hides a deep link's `?start=` payload in the message bubble: the chat shows a bare
  `/start` while the update carries the token. Do not conclude from the UI that the payload was lost.

- **The universe is loaded in the shared `traders` database** (2026-09-24, #53): the stack's
  `universe` container embedded 5,223 profiles (~$0.016) and loads 16,363 holdings on every start.
  `traders` is at `0021_topic_proposal_expiry` (see the stack bullet above; one active topic, no
  proposals yet).
  **`traders_m5`** is the scratch copy branches migrate natively. It is at
  `0022_narration_transitions` (migrated up, down and up again with seeded rows for #71 and for
  the narration notice; the rows were deleted) and disposable: point a run at it with
  `DATABASE_URL=postgresql://traders:traders@127.0.0.1:55432/traders_m5`.
- **The descriptions file lives at `data/universe/descriptions.local.jsonl` in the main
  checkout** (gitignored, and excluded from images by `.dockerignore`), with a spare copy at
  `data/local/`. A worktree needs its own copy to run `ingest_universe.py`. A fresh
  `build_instrument_universe.py` is ~1 h, so copy the file rather than refetching.
- **Running a worktree's orchestrator natively against your `.env` starts a second Telegram
  poller**, and MEMORY's rule is that a second poller silently steals updates from the stack's.
  Always start it with `TELEGRAM_UPDATES=off TELEGRAM_BOT_TOKEN= SCHEDULER_ENABLED=false`.
  **Port 8081 was held by an orchestrator left running from an old worktree**
  (`m3-slice-2-b2e605`, started 2026-09-24 08:41). A new process on 8081 dies on `EADDRINUSE`
  *after* logging that it started, and every request then silently reaches the old code. Check
  `lsof -nP -iTCP:<port> -sTCP:LISTEN` and the listener's `cwd` before trusting a native
  endpoint. 8083 was free. **As of 2026-09-27 that stray process (pid 85085) was still running**,
  with the bot token and `DATABASE_URL` pointing at `traders`. Its code predates the poller, so it
  cannot steal taps, but its scheduler may still run old-code scans. The user was told how to stop
  it (`kill 85085`); check whether they did.
- **In zsh, `$S:path` is a history modifier, not a string.** `git show $S:services/...` expanded
  `:s` as a substitution and failed. Write `git show "${S}:path"` when verifying a commit by
  content.
- **Docker Hub can time out from a session's sandbox** (`node:22-slim` metadata,
  `DeadlineExceeded`). On 2026-09-24 it was transient. **On 2026-09-30 it failed twice in a row**
  from the sandbox; `docker pull node:22-slim` run *outside* the sandbox, then `dev-docker.sh`
  (also outside), worked every time after. Retry before suspecting the Dockerfile.
- **The native preview for a PR that changes the AI service needs a native AI service too**
  (PR 8): uvicorn from the worktree on **8091** with `PYTHONPATH` set and the main checkout's
  venv, and the native orchestrator's `AI_SERVICE_URL` pointed at it; otherwise point it at the
  stack's `http://127.0.0.1:8001`. **Vite hot reload wipes in-memory store state** (`/ask`'s
  questions vanished mid-answer when a lib file was edited) - re-ask after edits, it is not a bug.
- **`/ask` on the free route is slow and costs nothing:** 18-69 s per model-written answer, once
  over 3 min; a refusal 0.6 s. The in-app browser's JS tool gives up after 45 s, so measure it
  with `curl` against `http://127.0.0.1:8001/ask` (`x-internal-key` from the main `.env`), not
  from the page.
- **Run a topic eval with the main checkout's `.env` sourced** — the worktree has none:
  `set -a && source /Users/a/projects/Traders/.env && set +a`, then override `DATABASE_URL` and set
  `CORPUS_DIR` to the worktree's `data/corpus` (the eval file is found beside it).

---

## Where to go next

### M3 is complete, and how it was verified

Every slice was verified by running it against the real database and, where it mattered, the real
embedding endpoint — not by reading it and not only by the hermetic suite, which structurally
cannot reach any of the SQL. What exists end to end:

- **The corpus** (`data/corpus/concepts/`, 9 documents, CC0), hash-compared ingestion that moves
  no chunk id on an unchanged run, and concept chips that open the document behind them (#42).
- **Hybrid retrieval**: `vector(1536)` sized for `openai/text-embedding-3-small`, `BaseEmbedder`
  and `VectorStore` behind Protocols, RRF over pgvector cosine and Postgres full-text, with the
  lexical half strict when the vector half is semantic and wide when it is the fixture (#44, #45).
- **`POST /ask`**: intent routing, citations quoted verbatim, a three-state relevance floor, three
  named ways to decline plus `advice`, arithmetic-only portfolio answers, and a hedge in the text
  of every weak match (#46, #47).
- **The eval set**: 35 cases in `data/eval/ask.json`, held out from the thresholds, run by
  `scripts/run_eval.py` — 16 keyless on every PR, all 35 when `OPENROUTER_API_KEY` is a repo
  secret. Last keyed run: **35/35**; last keyless: **16/16**.

The paid embedder is live in *this* installation's database and costs about a hundredth of a cent
per full re-embed. A fresh clone and CI use the keyless fixture, on purpose.

### Previewing a worktree's web app against the live stack

The stack's orchestrator allows browser requests only from `127.0.0.1:5174`, and its images are built
from the main checkout, so a worktree's UI change is invisible there. What worked (task 3): a
native orchestrator on **8083** with `SCHEDULER_ENABLED=false TELEGRAM_UPDATES=off
TELEGRAM_BOT_TOKEN=`, `ALLOWED_ORIGINS=http://127.0.0.1:5179`, `REDIS_URL=redis://127.0.0.1:6379`
and `DATABASE_URL`/`AI_SERVICE_URL` pointed at the host ports; and `vite --port 5179` with
`VITE_API_BASE_URL=http://127.0.0.1:8083`. The session cookie is per host, not per port, so the
in-app browser's existing sign-in carries over and nobody types the passphrase. A
`.claude/launch.json` for `preview_start` is **not gitignored** - delete it before committing.

**The recipe as rebuilt in the M6 session (worked all session):** two tiny scripts in the session
scratchpad, named in `.claude/launch.json`, and `.claude/launch.json` added to
`$(git rev-parse --git-common-dir)/info/exclude` so it can never be committed. The orchestrator
script does `set -a; source /Users/a/projects/Traders/.env; set +a`, exports the overrides above
plus `ORCHESTRATOR_PORT=8083` and `DATABASE_URL=postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:55432/$POSTGRES_DB`,
then `cd apps/orchestrator && exec pnpm start`; the web script runs
`VITE_API_BASE_URL=http://127.0.0.1:8083 pnpm exec vite --port 5179 --strictPort --host 127.0.0.1`.
Pitfalls that cost time: **a new worktree needs `pnpm install`** before either starts;
`pnpm start` does **not** reload, so restart the orchestrator preview after editing its code (vite
does reload); the in-app browser pane counts as a **hidden page** when not in front, so TanStack
Query's interval refetches never fire there (prove intervals in a test instead); and a screenshot
of a scrolled page sometimes shows a blank band - measure with `getBoundingClientRect` instead.
**This Mac runs in `Asia/Jerusalem`; the containers run in UTC** - a native preview is the only
place a timezone bug shows (it is how #95's day-early dates were found).

### M5 is complete, and how it was verified

**Exit:** *a free-text topic resolves to a sensible confirmed instrument set and produces topic
observations; a rejected auto-proposal does not return within the rejection cooldown.*
- **Resolve, confirm, observe** - #53-#57, checked live against the real universe and embedder,
  including a race for the last topic slot; `topic_scan` writes `topic_move` findings.
- **A real theme proposed** - 2026-09-29, after the market feed (decision 60): "data center" and
  "bond yields" (confident), then "interest rates", "canadian imports", "anthropic ipo", "short
  interest" (weak; the last two are the debt table's). Seen on the Topics page, toggle included.
- **A rejection holds** - "canadian imports" rejected in the UI; the next run with a fresh run
  key recorded *matches rejected topic "canadian imports" by words* in `runs.stats`.

What the feed and discovery look like now: GDELT's raw files feed two filters (followed names;
market tags AND market words, minus named ticker networks and press-release wires); discovery
reads linked and market headlines over 7 days, drops one company's news (decision 59) and one
foreign country's press (decision 61), resolves at most 8, and proposes in two bands with two
caps (decision 62). Every phrase not proposed carries its reason in `runs.stats.notProposed`.

**How to reproduce a feed measurement (read-only):** download `https://data.gdeltproject.org/
gdeltv2/<YYYYMMDDHHMMSS>.gkg.csv.zip` for past slots into a scratch directory (~3 MB each, 96 a
day); parse as `app/news/gdelt.read_gkg` does (tab-separated, `csv.field_size_limit(sys.maxsize)`,
title from `<PAGE_TITLE>` in column 26, outlet column 3, URL column 4, themes column 8); keep rows
with `market_feed.is_market_headline` and not `is_excluded_outlet`; attach
`outlet_countries.load_outlet_countries(...)` codes to `Headline`s; call `recurring_phrases`, and
resolve the top phrases through the live `/topics/resolve`, which stores nothing. The scripts
lived in the session scratchpad and are gone - about 100 lines, all of them glue around those
functions.

### Next session: M6, continued

**Decided with the user (2026-09-29), do not re-litigate:** TanStack Query first (done); the equity
curve from stored snapshots only, gaps as gaps (done); **settings: base currency shown as fixed
"USD" (guideline 10) and severity bands read-only - no schema or backend change**; router is
TanStack Router (done); duplicate drift proposals are a debt row, not M6 work.

The remaining PRs, in order, one branch off `main` each:

| # | PR | What "done" means, and what was already measured |
|---|---|---|
| ~~8~~ | ~~Per-holding detail~~ | **Done** (decision 68), after #98 (a correctness bug found while measuring for it: the backfill stored a day still trading as its close). Seen at 1280 and 375 px against live data |
| ~~9~~ | ~~Proposals inbox~~ | **Done** (decision 69). Seen at 1280 and 375 px against live data; no decision was clicked - a decision's request is pinned by `proposalPages.test.tsx` |
| ~~10~~ | ~~A screen for `/ask`~~ | **Done** (decision 70), after #101 (a looping model answer had passed the evidence validator). Seen at 1280 and 375 px with real questions: a weak match, a refusal, a computed answer, an advice refusal |
| ~~11~~ | ~~Observations feed~~ | **Done** (decision 71), with the severity tie-break fix. Seen at 1280 and 375 px: filters, paging and a reloaded filtered address |
| ~~12~~ | ~~Mobile pass~~ | **Done** (decision 72). Every page measured at 375 px first; only the dashboard needed work |
| 13 | **Times, disclaimers, settings copy** | Timestamps in `APP_TIMEZONE` rather than the browser locale (`formatExactTime`, `toLocaleString` in 6 places); base currency shown as fixed USD in Settings; the disclaimer on every page |
| 14 | **M6's closing handoff** | Check the exit - every PRD user-facing FR reachable, no dead ends or unhandled error states - and update this file |

**First, a two-minute check left from #98:** a 06:45 UTC backfill on 2026-09-30 wrote BTC-USD
and ETH-USD rows dated **2026-09-30 20:00 UTC** (in the future then). #98 stops new ones and makes
the backfill replace its own rows, so the first scheduled backfill after 30 Sep 20:00 UTC should
have rewritten both with the finished day's close. Confirm with
`SELECT i.symbol, q.as_of, q.price_minor FROM quotes q JOIN instruments i ON i.id = q.instrument_id
WHERE q.as_of::date = '2026-09-30' AND q.delay_seconds = 0` and `runs` (`kind = 'backfill'`,
`stats->>'written'`); nothing dated after `now()` should exist. If the stack was down all night,
run a manual backfill (`POST /internal/runs {"kind":"backfill"}`) - it is idempotent.

How this session worked, and it held up: measure first (read-only SQL and the browser), then
decide, then build; every screen looked at in the in-app browser at 1280 and 375 px against live
data; **never click a real decision (Approve/Reject/Snooze) or save real settings** - the user's
data is live, and a decision's request is pinned by tests instead. Each correctness bug found on
the way (#89, #96, #98, #101) went in as its own PR ahead of the screen that exposed it - three of
the four were found only by *measuring the live data or the live endpoint* before building, not
by reading code or by the suites. Keep doing that for PRs 11-13.

**CI note:** a `docker compose smoke test` failure inside `corepack` downloading pnpm (an undici
`assert(!this.paused)`) was transient on #93; `gh run rerun <id> --failed` passed. Check the PR does
not touch dependencies before assuming that.

Standing permissions do not carry across sessions: ask again about merging, rebuilding, deleting
data and acting in the UI.

### Left unfinished, deliberately

The **notification on narration state change** is now built (independent task 2, decision 58) and was
verified with a real message in the bound chat on 2026-09-28, not only to the ledger.

Whichever is next, the seams M4 leaves are: `notifications.ref_kind` already anticipates a third
referent, `Notifier` takes another channel without touching the fan-out, and `PROPOSABLE_KINDS` in
`services/proposals.ts` is the entire policy for what becomes a question — one map, deliberately
short, and the place to argue about before adding to it.

**Before the first real deployment**, read decision 20 and set `TELEGRAM_SIGNING_SECRET` to a value
that is not the webhook secret. An unset signing secret degrades to a null notifier with a stated
reason rather than booting broken, so the mistake is visible — but a *shared* value would not be.
