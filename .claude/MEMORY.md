# Project memory — Traders

Written for a session that has never seen the conversation that built this. The code is readable;
the reasoning behind it is not, and that is what this file is for. Maintained per
[CLAUDE.md](../CLAUDE.md) "Session management & memory".

Updated: 2026-09-24. **M3 slices 1–3 are done.** The paid embedder that slice 2
recorded as owed is verified against the live endpoint, so retrieval is genuinely
semantic; `POST /ask` answers concept and portfolio questions with citations and refuses
what the corpus does not cover. **Only slice 4 — the eval set — remains**, and several
numbers recorded here are explicitly waiting on it. M4 is complete; M3's remaining
two slices — `POST /ask`, then the eval set — are not started. The session that wrote this gave the
corpus an embedding column whose width was chosen for a named model rather than for the fixture
that fills it, and then found two retrieval bugs by running the SQL that 40 passing tests could not
have caught.

**One-line state:** the product imports a portfolio, fetches six months of real daily prices, scans
it every 30 minutes for four kinds of finding, explains each one in sentences whose every figure is
checked against the evidence, **links every term in those sentences to an explanation of it**,
**answers a question phrased in the user's own words with the passages that bear on it —
by meaning, not by shared vocabulary**, lets
the user state the allocation they meant to hold, and turns the drift from it into a proposal with
a deadline that an approval writes to a paper ledger. No order is ever placed. The explanations are
currently written by templates rather than a model, and the app says so on its own dashboard.

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
| **M3 — RAG & educational engine** | 🟡 Slices 1–3 of 4 complete | #42: corpus, schema, ingestion, live concept links. Slice 2: `vector(1536)`, `BaseEmbedder`, `VectorStore`, hybrid retrieval and `GET /concepts/search`. Slice 3 (#46): `POST /ask`, intent routing, citations, a three-state relevance floor. **Slice 4 (the eval set) is next and several numbers are waiting on it** |
| **M4 — Scheduling, HITL & Telegram** | ✅ Complete | PRs #26–#33. Mastra adopted for `proposalLifecycle` only |
| M5 — Market discovery & topics | Not started | independent of M3; deferred in favour of finishing M3 (decided 2026-09-23) |
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

The corpus is a derived copy and is not covered by any of those. `cd services/ai &&
DATABASE_URL=postgresql://traders:traders@127.0.0.1:55432/traders .venv/bin/python
scripts/ingest_corpus.py --dry-run` answers whether the database is in step with `data/corpus/`.

Test counts at handoff: **1,083** — 573 Python, 341 orchestrator, 153 web, 16 shared.

**None of them executes a line of retrieval SQL**, and that is structural rather than an oversight:
the Python suite is hermetic and has no Postgres. Exercise it by hand after touching
`app/corpus/` — see the two bugs below that a full green gate did not catch.

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
| `GET /concepts/search?q=` | hybrid retrieval: the half of `/ask` that finds things. A diagnostic surface with no relevance floor and no refusal — those are `/ask`'s judgements. Every match reports `vector_rank` and `text_rank`, so *which half found this* is answerable; `vector_is_semantic: false` says the embedder ranks by shared words alone |

---

## What exists, by area

**`services/ai`** (Python, FastAPI) — market data providers behind a chain with caching, rate
limiting and per-provider daily budgets; four deterministic analysis rules; news ingestion with
entity extraction; an LLM provider factory with a daily spend guard; narration behind an evidence
validator; **the concept corpus: structure-aware chunking, hash-compared ingestion and slug
lookup, and **hybrid retrieval over it: an embedder behind `BaseEmbedder`, a `VectorStore` over
pgvector, and reciprocal-rank fusion of the vector and full-text halves**; the Alembic schema (13
migrations) that both services share.

**`apps/orchestrator`** (Node, Hono) — sessions, holdings CRUD, CSV/JSON import with per-row
validation, valuation with FX, target weights, the scan workflow, run claims, the observations feed,
the local scheduler, **the proposal state machine and its audit trail, the notification fan-out, the
Telegram adapter, and per-user settings**.

**`apps/web`** (React, MobX, Tailwind, Recharts) — login, portfolio dashboard, import wizard,
observations feed with an evidence drawer, the approvals inbox, a settings page, **and the concept
dialog behind the feed's chips**.

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

---

## Current technical debt

| Item | Where | Impact |
|---|---|---|
| **Telegram's inbound delivery is unproven** | deployment | Everything else was exercised against a real bot, but `setWebhook` needs a public HTTPS URL. The handler has only ever been driven by replaying genuine payloads at it locally. **The first real deployment is the first real test of that leg** — check `getWebhookInfo` for `last_error_message` immediately after |
| **`queries.ts` conflicts on every parallel PR** | `src/db/queries.ts` | Four M4 PRs appended a section to the end of one 1,200-line file, and every rebase put a conflict marker exactly where one function's closing brace met the next block's header — the brace was lost and hand-repaired **three separate times**. It is the cost of CLAUDE.md's "all SQL in one file" rule, which is otherwise good. Worth deciding whether to split by domain with an index |
| **Migration 0008 hard-codes a table Mastra owns** | `0008_mastra_workflow_state.py` | The library would create `mastra_workflow_snapshot` itself; Alembic creates it instead (`disableInit: true`), because CLAUDE.md says the AI service owns the schema. An upgrade that changes the shape breaks suspended runs — so `test/mastraSchemaOwnership.test.ts` compares the migration against `WorkflowsPG.getExportDDL()` and fails the build first. Two other things cost time to find: `PostgresStore` creates **43** tables for 24 storage domains unless you route only `workflows`, and `@mastra/core` posts feature-usage telemetry to PostHog unless `MASTRA_TELEMETRY_DISABLED` is set (it is, in `workflowRuntime.ts`, in code rather than `.env`) |
| ~~Concept chips point nowhere~~ | — | **Resolved in M3 slice 1.** Kept as a line rather than deleted because it stood here from M2 to M4 and its absence would otherwise read as an oversight |
| ~~Retrieval is exact-match only~~ | — | **Resolved in M3 slice 2.** Hybrid retrieval exists and `GET /concepts/search` serves it. What is still missing is the *answer*: there is no `/ask`, no intent routing, no citations and no relevance floor, so a nonsense query still returns the three least-bad chunks rather than a refusal. That is slice 3 |
| **No test executes a line of retrieval SQL** | `services/ai/tests` | The Python suite is hermetic and has no Postgres, by design. Both of slice 2's real bugs lived there and both passed a full green gate. The compose `corpus` container covers ingestion only; the search path has no CI coverage at all and is exercised by hand. Closing this means a Postgres-backed test job, which is a real decision about what "hermetic" is worth |
| ~~OWED: migrate the fixture embedder to a paid OpenRouter embeddings model~~ | — | **Done.** `openai/text-embedding-3-small` through OpenRouter, verified against the live endpoint: 36 chunks, 5,114 tokens, **$0.00010228**, no chunk id moved. Set `EMBEDDINGS_PROVIDER=openrouter` to use it; the code default stays `fixture` so CI and a fresh clone remain keyless. The fixture was **not** deleted — it is the hermetic CI path and slice 4's eval set needs it |
| **Retrieval quality rests on six hand-written questions** | `services/ai/app/corpus/retrieval.py` | The strict/wide lexical switch, and the claim that the real embedder is 5/6 against the fixture's 1/6, come from six questions this session wrote — chosen after seeing the corpus, which is the weakest possible evidence short of none. The direction matches theory and the mechanism is understood, but **nobody should tune retrieval further on this basis**. Slice 4's eval set is what turns it into a measurement |
| **The corpus is a derived copy that three separate mechanisms keep in step** | `data/corpus`, compose, `.claude` | The files are the source of truth and `kb_documents`/`kb_chunks` are what the API serves. A hook covers Claude's edits, the `corpus` container covers every stack start, CI covers the image. None of the three covers a hand edit on a machine with no stack running — that reader sees stale text with nothing reporting the disagreement. `--dry-run` answers "are they in step?" and nobody is obliged to run it |
| **The ingest hook does not apply to a session started before it existed** | `.claude/settings.json` | The settings watcher only watches directories that had a settings file when the session began, and `.claude/` had none. Any session started after that commit picks it up; the session that wrote it did not, and confirmed so with a sentinel rather than assuming |
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
- **The dev database is at `0013_kb_embeddings`, applied natively while the running containers were
  built from `main` at 0012.** This is the recurring hazard recorded below, and it is harmless in
  this direction — 0013 only adds nullable columns and an index, which the 0012-era code ignores.
  It stops being harmless on the next `dev-docker.sh`, where the `migrate` image still built from
  `main` dies with `Can't locate revision '0013_kb_embeddings'`. The fix is always `docker compose
  build`, never touching the database.
- **`.env` must set `EMBEDDINGS_PROVIDER=openrouter`** to get semantic retrieval; the code
  default is `fixture` and stays that way so CI and a fresh clone need no key. This is a
  deliberate `.env` / `.env.example` asymmetry, like `MARKET_DATA_PROVIDERS` above — do not
  "fix" it. The M0 placeholders `EMBEDDINGS_MODEL=BAAI/bge-small-en-v1.5` and
  `EMBEDDINGS_DIM=384` must be deleted; `fastembed` names an adapter nobody wrote and the
  service refuses to start on it, deliberately and with a message saying what to set.
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

**Two chains are now proven by observation rather than by argument.** M4's (#35): targets set in
the UI produced four drift findings, three became `pending` `rebalance` proposals with 24-hour
deadlines, and the notification ledger recorded three `above_floor` attempts plus one `below_floor`
deferral into the digest. And M3 slices 1 and 2's, below.

**M3 slice 1 is merged (#42).** Verified by using it in a
stack rebuilt from the main checkout, not by reading it: the `corpus` container ran on start and
reported nine documents unchanged; signing in and clicking **Drawdown** on a real drawdown
observation opened the document with its formula as a code block; clicking **Rebalancing** on an
allocation-drift observation showed "This system never places an order" in bold in its second
paragraph. Clicking the same concept from a second observation served from the session cache — two
GETs for two concepts across four clicks, read from the network log. That chain is an observation
now, not an argument.

What exists: `data/corpus/concepts/*.md` (nine documents, four sections each, CC0), migration
`0012_kb_corpus`, `app/corpus/` (pure chunking, ingestion, and a slug repository),
`scripts/ingest_corpus.py`, `GET /concepts` and `GET /concepts/:slug` on the AI service, a proxy on
the orchestrator, and `ConceptStore` + `ConceptDialog` on the web.

### M3 slice 2 is merged

**Verified by running it, not by reading it** — against the real dev database, because nothing in
CI can reach this SQL. Migration `0013` applied cleanly; the ingester embedded all 36 chunks and a
second run embedded none; **all 36 chunk ids were byte-identical afterwards**, which is what makes
a citation survive a re-ingest. Appending a sentence to one document rewrote exactly one chunk and
re-embedded exactly that one, leaving the other 35 vectors and every id untouched — the conditional
`embedding = CASE WHEN ... text IS DISTINCT FROM ...` in `ingest.py` doing its job. Through HTTP,
`GET /concepts/search?q=approving+a+proposal+places+an+order` returns `rebalancing / What it is` —
the section that says the system never places one — at rank 1, found by **both** halves.

What exists: migration `0013_kb_embeddings` (`vector(1536)` + `embedding_model` + an HNSW cosine
index + a CHECK that the two columns are null together), `app/corpus/embeddings.py` (`BaseEmbedder`,
`EMBEDDING_DIMENSION`), `hashed_embedder.py`, `embedder_factory.py`, `vector_store.py`
(`VectorStore` + `PgVectorStore`), `retrieval.py` (RRF + the full-text half + `hybrid_search`),
`GET /concepts/search` with an orchestrator proxy, and `EMBEDDINGS_PROVIDER` in config.

Three things a later session should not re-derive:

1. **`embedding_model` per row is what makes the owed migration safe.** Fixture vectors and OpenAI
   vectors are the same width and are not comparable, so a partial re-embed would rank two
   coordinate systems against each other and call the result relevance. With the model on the row,
   "embed everything this embedder did not produce" is a `WHERE` clause, and `search` filters to
   one model so a half-migrated corpus degrades visibly instead of lying.

2. **Both halves' ranks are on the wire, and so is `vector_is_semantic`.** A null `vector_rank` on
   every match means the corpus was never embedded — otherwise indistinguishable from working
   hybrid retrieval. These are diagnostics that survive into production, not debug output.

3. **There is deliberately no relevance floor.** A nonsense query returns the three least-bad
   chunks today. Deciding the corpus does not cover a question is `/ask`'s judgement; making it
   here as well would put one threshold in two places and let a question be refused by a number
   nobody chose.

### M3 slice 3 is done (#46)

`POST /ask` on the AI service, proxied by the orchestrator, which values the portfolio
and sends it with **every** question — routing happens in the AI service, so a second
classifier here could disagree with it, and the disagreement is silent.

Verified by running it against the real corpus, not by reading it: "what is a drawdown"
→ confident (0.712), three citations; "how much did I lose from the top" → weak (0.338),
answered from the drawdown document; "how do I roast a chicken" → **refused** (0.052);
"what is my largest position" → computed, 72.2% of the priced total, with the unpriced
holding reported rather than dropped. Both narration branches were exercised: the free
route timed out and fell back to the extract, and a paid model produced a grounded
answer that passed the evidence validator.

### M3 slice 4 — the eval set, and the numbers waiting on it

~30 Q/A pairs run in CI. It is the last slice, and it is **not** a formality: three
separate decisions are currently resting on evidence too weak to defend, all of them
recorded above as debt.

1. **The relevance thresholds** (`REFUSE_BELOW = 0.23`, `CONFIDENT_ABOVE = 0.40`) come
   from sixteen questions written by the session that chose them. Re-derive them.
2. **The strict/wide lexical switch** rests on six paraphrased questions. Six.
3. **The reranker** DESIGN.md asks for was deferred *specifically* until something could
   measure it. This is that something — build the eval set first, then the reranker
   against it, in that order.

The eval set must run on the **fixture** embedder, because CI is keyless — and that
constrains it more than it first appears. It cannot measure semantic retrieval quality,
and **it cannot measure the `not_in_corpus` refusal either**: the relevance floor
deliberately abstains when the vector half is a placeholder, so on the fixture path
*every* concept question is answerable and graded `weak`. That refusal — the one M3's
exit criterion actually names — is reachable **only with a real embedder**. (This file
said otherwise until the smoke test was extended and the assertion turned out to be
unwritable; see the bug below.) What CI *can* measure is the deterministic half: intent
routing, the `no_holdings` and `not_computable` refusals, citation shape, and pipeline
stability. So the decision for slice 4 is sharper than "is a keyed job worth it": **without
one, the headline refusal behaviour is never tested by anything automated.**

### M5 (topics), deferred

Independent of M3's remaining slices and the larger change: it widens `notifications.ref_kind` and
wants topic-shaped proposals. It was weighed against slice 2 on 2026-09-23 and **deliberately
deferred in favour of finishing M3**, on the grounds that the corpus currently exists but is inert
— it can only answer a question phrased as the exact slug a chip already knows — and finishing
something half-built beats opening a second front. See the seams M4 left, below.

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
