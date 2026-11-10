# Review — Software engineering / architecture (2026-11-10)

Scope: cross-cutting architecture, code health and test strategy at `95e4c6e` (VERSION 0.0.3).
Read-only: no stack, test suite, database or model was run. Counts come from `wc`, `grep` and
`git log` on the working tree. Security, database, backend internals, frontend and devops are
other reviewers' ground and are touched only where they cross a boundary.

## Summary (5 lines max)

The code is in better shape than its size and pace (431 commits in 8 weeks, ~89k source lines, ~66k test lines) would predict: boundaries are real, run idempotency is carefully built, and CI is broad.
The largest risk is not in the code. `.claude/MEMORY.md` is 895 KB and is the only home of ~400 decisions; no session can read it, so the handoff the process depends on is already partial.
Second: the Python service has no lockfile, so every image build and CI run resolves `yfinance`, `openai` and `langfuse` afresh.
Third: the two-service split duplicates portfolio maths (net worth, returns, rounding) with a parity test only for fees, and the TypeScript valuation path multiplies money as floats against guideline 3.
Fourth: the orchestrator's SQL is mocked away in 61 of 96 test files and nothing measures which statements the Postgres suite actually executes.

## What is strong and should stay

- **Run claiming.** The `INSERT ... ON CONFLICT DO NOTHING` claim, the heartbeat-based reclaim and
  "a failed run is recorded as failed, not left claimed" are correct and explained where they live
  (`apps/orchestrator/src/db/queries/runs.ts:69-140`,
  `apps/orchestrator/src/http/routes/internal.ts:164-190`). Bucket policy sits at the endpoint, so
  the timer and the CronJob cannot disagree (`internal.ts:66-99`).
- **The orchestrator-to-AI wire.** Types generated from the committed OpenAPI file, every response
  parsed by zod at runtime, and each zod schema pinned to its generated type by `Expect<Equal<>>`
  (`packages/shared/src/ai/schemas.ts:1-35`). CI fails on a stale `openapi.json` and a stale
  client (`.github/workflows/ci.yml:33-37`, `:60`). This is the best-built boundary in the
  repository; finding 6 asks for a fraction of it on the other wire.
- **SQL confinement.** A grep for SQL keywords outside `apps/orchestrator/src/db/queries/` finds
  one file, `http/routes/health.ts`. The convention in CLAUDE.md is true.
- **Hermeticity is enforced, not hoped for.** `services/ai/tests/conftest.py:19-31` builds settings
  with `_env_file=None`; the Postgres suite refuses to pass by skipping when
  `INTEGRATION_REQUIRED=1` (`apps/orchestrator/test/queries.postgres.test.ts:22-25`) and refuses a
  database not named `_ci`/`_test` (`:39-41`). No `sleep` in the Python tests; no `.only`/`.skip`
  left behind.
- **Error handling and logging.** Zero `console.*` in `apps/orchestrator/src`; the 13 bare `catch`
  blocks and 37 Python `noqa: BLE001` sites I sampled each say why they swallow. Degraded states
  are first-class (`valuation.ts:116-121`: a quote failure serves an unpriced portfolio).
- **The LLM layer's shape.** One factory, decorators for budget, recording, payer and model choice
  (`services/ai/app/llm/factory.py:1-36`). Callers do receive an `LLMProvider`.
- **CI breadth.** Five jobs: Python, TypeScript, Postgres integration, a compose smoke test with a
  real backup restore, and a kind deployment (`ci.yml:13`, `:39`, `:79`, `:127`, `:265`).
- **Function size.** The longest Python function is 159 lines
  (`services/ai/app/assistant/tools.py:158`, `get_portfolio`); only a handful exceed 120. Large
  files are mostly many small units, with the exceptions in finding 10.

## Findings (ranked)

### 1. The handoff document has outgrown any reader — High

- **Evidence.** `.claude/MEMORY.md` is 10,259 lines / 895,066 bytes (`wc`), roughly 220k tokens.
  The decisions section alone is lines 1611-6879. The file was touched in 286 of 431 commits
  (`git log --name-only`), 11,947 lines added against 1,687 removed. "Where to go next"
  (line 8193 on) holds about 45 dated "Next session" sections, many titled "(history - superseded
  ...)" (for example lines 9073, 9378, 9394, 9658). The debt table (7700-7817) has 45
  struck-through resolved rows beside 64 open ones, and the file itself records that open rows
  are stale (line 8346) and that two sessions fixed the same debt at once (8436-8438).
  `docs/DECISIONS.md` is only a generated index of titles (`scripts/build_decision_index.py:1-11`);
  the reasoning exists nowhere else. Decisions are cited under at least three schemes
  ("decision 92", "D392", "M10 decision 4 (a)", "D25 of `PROPOSAL-MULTI-AGENT.md`" -
  `docs/DESIGN.md` section 4).
- **Cost.** CLAUDE.md's rule is "start a new session from the handoff". No session can load this
  file, so each one reads the top and greps, which is the "re-derive it" failure the file exists to
  prevent. It is also the repository's top merge-conflict surface, and a single bad edit can
  silently damage decisions nobody will re-read. Growth is monotonic: the append-only design has no
  mechanism that ever removes anything.
- **Proposal.** (a) One file per decision under `docs/decisions/D0392-research-advice.md` with a
  small front-matter (number, date, PR, status, supersedes); the index script reads the directory
  instead of MEMORY.md, and one numbering scheme (`D###`) is used everywhere. (b) MEMORY.md becomes
  state only - current status, open debt, environment, next step - with a CI size budget (say 400
  lines) so the trigger is countable, like the five-PR rule. (c) Superseded "Next session" sections
  and resolved debt rows are deleted; `git log` keeps them. (d) Bug lessons move to
  `docs/LESSONS.md`. The move is mechanical and can be scripted from the existing numbered list.
- **Effort.** M (a script plus one docs-only PR; no code changes).

### 2. Python dependencies are not locked — High

- **Evidence.** `services/ai/pyproject.toml:9-31` declares floors only (`yfinance>=0.2.44` at :17,
  `openai>=3.31` at :25, `langfuse>=5.1` at :31). `git ls-files` shows no `uv.lock`,
  `requirements*.txt` or constraints file. CI installs with `uv pip install -e '.[dev]'`
  (`.github/workflows/ci.yml:23`, `:101`); the image with `pip install --no-cache-dir .`
  (`infra/docker/Dockerfile.ai:21`). The TypeScript side is locked (`pnpm install
  --frozen-lockfile`, `ci.yml:53`). No Dependabot or Renovate config is tracked. Not a recorded
  decision (no match for "lock" in `docs/DECISIONS.md` or MEMORY.md).
- **Cost.** The image deployed to production contains whatever PyPI served at build time, which is
  not what CI tested an hour earlier. `yfinance` is an unofficial scraper that breaks and changes
  shape often; a rebuild during an unrelated deploy can change price behaviour with no diff in the
  repository, and a rollback rebuild does not restore the old versions. This directly undermines
  "compose first, then production".
- **Proposal.** Commit `uv.lock` (`uv lock`), install with `uv sync --frozen` in CI and in the
  Dockerfile, and add a weekly dependency-update PR (Dependabot covers both `uv` and pnpm). Also
  stop installing `pytest` and `ruff` into the runtime image (`Dockerfile.ai:21`) unless the
  devops review finds a reason for it.
- **Effort.** S.

### 3. Portfolio maths exists in both languages, pinned only for fees — High

- **Evidence.** Fees are deliberately duplicated and each file names the other and the shared test
  cases (`services/ai/app/core/fees.py:16-19`, `packages/shared/src/fees.ts:16-19`) - that is the
  right pattern. The rest is not treated that way. The assistant computes an agent's net worth and
  return itself (`services/ai/app/assistant/tools.py:517-539`) and month-to-date change (`:503-507`,
  `:548`, `:620`), while the screens get them from `apps/orchestrator/src/services/performance.ts`
  (`:285-306`). The Python return is "against its paper budget" (`tools.py:536-538`); the
  TypeScript P&L is `netWorth - deposits` (`performance.ts:298`). Rounding differs three ways:
  `ROUND_HALF_UP` in `core/money.py:24`, `Math.round` in `packages/shared/src/money.ts:72`, and the
  decimal context default (half-even) at `tools.py:534`. A grep of the Python tree for a reference
  to `performance.ts` or `valuation.ts` finds none.
- **Cost.** Ask can state a net worth or return that differs from the Agents page for the same
  agent at the same moment. The evidence validator cannot catch it: both figures are "sourced",
  from different implementations. In an advisory product a disagreeing figure is the most
  damaging kind of bug because each side looks correct alone.
- **Proposal.** Pick one owner per derived figure. Cheapest: the orchestrator already computes
  performance, so pass the computed figures into the assistant's context (or expose them through an
  internal route the tool calls) and delete the Python copy. Where duplication must stay, copy the
  fees pattern: one shared JSON case file under `data/` that both `pytest` and `vitest` load, so a
  change on one side fails the other. Use `ROUND_HALF_UP` explicitly at `tools.py:534`.
- **Effort.** M.

### 4. The TypeScript valuation path uses float arithmetic and returns zero on bad input — Medium

- **Evidence.** `scaleMinor` is `Math.round(minor * Number(quantity))` and returns `0` when the
  quantity does not parse (`packages/shared/src/money.ts:69-73`); `convertMinor` multiplies by
  `Number(rate)` and returns `0` for an unusable rate (`:76-88`). Both feed every dashboard figure
  (`apps/orchestrator/src/services/valuation.ts:138-141`). The ledger path does it properly with
  `bigint` (`packages/shared/src/fees.ts:22-49`, `services/fills.ts:168-172`). Two routes carry
  their own copy of a decimal-to-cents parser (`http/routes/agents.ts:148-150`,
  `http/routes/portfolioCash.ts:49-51`) beside `parseToMinor` (`money.ts:36`). Not a recorded
  decision.
- **Cost.** Guideline 3 says "integer arithmetic in TypeScript ... never a float" and guideline 7
  says an unavailable value is never zero. The code promises both in its header and keeps neither
  on this path. Quantities are `numeric(38,18)`; a float product is exact only while it fits 53
  bits, and a silent `0` is the "position valued at zero" the project names as its worst outcome.
  In practice zod guards the inputs, so today this is latent - but the rule is non-negotiable and
  the next caller will trust the function's name.
- **Proposal.** Reimplement `scaleMinor`/`convertMinor` on `bigint` with scaled decimal strings
  (the pattern is already in `fees.ts`), return `null` instead of `0`, and let the type force
  callers to handle it. Replace the two route parsers with `parseToMinor`. Add a property test
  comparing against exact arithmetic over 18-decimal quantities.
- **Effort.** S-M.

### 5. Nothing measures which SQL the tests execute — Medium

- **Evidence.** 61 of the 96 orchestrator test files replace the whole query layer
  (`vi.mock('../src/db/queries.js')`; 47 also mock `db/pool.js`). The real statements run in two
  opt-in files, one of them 3,640 lines (`apps/orchestrator/test/queries.postgres.test.ts`, the
  largest file in the repository and the 6th most-changed, 85 commits). Its own header states the
  history: "until this file no statement in it had run under a test" (`:4-5`). Of 215 functions
  exported from `src/db/queries/`, 56 are not named in either Postgres test file (among them
  `createProposals`, `listProposalsToExpire`, `updateHolding`, `recordProposalAttempt`,
  `listFills`); some are reached indirectly (`applyDecision` at `:2979`, the app-level
  `m9Exit.postgres.test.ts`), so the true gap is smaller and unknown. No coverage tool is
  configured in any package.
- **Cost.** A mocked query proves the caller, not the statement. Row types are an unchecked generic
  (`query<HoldingRow>(...)`, `src/db/queries/holdings.ts:21-22`) over a schema another language
  owns, so a renamed column or a changed cast in a migration compiles, passes 61 files, and fails
  only if the one big file happens to call that function.
- **Proposal.** (a) Turn on V8 coverage for the Postgres job, scoped to `src/db/queries/**`, and
  fail under an agreed floor; that converts "56 by name" into a real list. (b) Split the 3,640-line
  file one-per-concept to mirror `src/db/queries/` (it conflicts for the same reason `queries.ts`
  once did - debt row "`queries.ts` conflicts on every parallel PR", resolved by the same split).
  (c) Consider generated row types from the migrated schema (`kysely-codegen` or `pgtyped`); per
  convention 5 this is a question for the owner: it replaces ~40 hand-written row interfaces and
  costs a dev dependency and a generation step in CI.
- **Effort.** S for (a), M for (b), M-L for (c).

### 6. The web-to-orchestrator contract is a cast — Medium

- **Evidence.** `apps/web/src/api/client.ts:84` returns `body as T`. The contract is
  `packages/shared/src/types.ts`: 2,533 lines, 261 exports, the most-changed source file (89
  commits). Compare the AI wire, whose header explains exactly why a cast was replaced by a parse
  ("`price_minor` became `undefined` ... the dashboard rendered a plausible wrong number with no
  error anywhere", `packages/shared/src/ai/schemas.ts:4-11`).
- **Cost.** The same failure mode on the other wire. Web and orchestrator ship together, so the
  exposure is an open tab or an installed app (D391) across a deploy, or a route that builds its
  body without a type annotation. Low frequency, but it produces wrong money on screen rather than
  an error.
- **Proposal.** Do not validate all 261 types. (a) Split `types.ts` by concept (its section
  banners at lines 703-2407 already mark the seams). (b) Add zod parsing for the money-bearing
  reads only (portfolio, holdings, performance, proposals) in the shared package, used by both
  the route (`satisfies`) and the client. (c) Send the build version (D352 already puts it in the
  header) on every response and have the client prompt a reload on mismatch.
- **Effort.** M.

### 7. DESIGN.md describes a system that no longer exists — Medium

- **Evidence.** CLAUDE.md tells every session to read it before changing architecture. It is
  marked "Draft v0.1" (`docs/DESIGN.md:3`); names LangChain (`:200`) and LangSmith (`:213`) where
  the code uses the `openai` package and Langfuse (`pyproject.toml:22-31`); lists Alpha Vantage,
  Finnhub and CoinGecko providers (section 4) where `services/ai/app/providers/` holds `fixture.py`
  and `yfinance_provider.py` only; gives a quote TTL of 300 s and 60 s in the same section; and its
  data model (section 3) has none of `agents`, `fills`, `agent_cash`, `cash_movements`,
  `agent_scans` or the research and assistant tables (57 `create_table` calls across 86
  migrations).
- **Cost.** A new session forms its model of the system from the one document it is told to read,
  and that model omits the whole multi-agent ledger - the part where mistakes cost most.
- **Proposal.** Rewrite sections 1, 3, 4 and 8 from the code, drop "Draft", and generate the table
  list from the migrated schema so it cannot rot. Pair this with finding 1: decisions leave
  MEMORY.md, DESIGN.md states the present.
- **Effort.** S-M.

### 8. Static analysis stops at the compiler — Medium

- **Evidence.** `lint` is `tsc --noEmit` in all three TypeScript packages
  (`apps/orchestrator/package.json`, `apps/web/package.json`, `packages/shared/package.json`,
  `scripts.lint`); no ESLint config is tracked. `mypy` is a dev dependency with a config block
  (`services/ai/pyproject.toml:39`, `:57-61`, `strict = false`) and is not run by CI
  (`ci.yml:24-27` runs ruff only). Pytest silences every `DeprecationWarning`
  (`pyproject.toml`, `filterwarnings`). No coverage in any language.
- **Cost.** Floating promises and unhandled rejections in an async server with a scheduler and a
  Telegram poller are exactly what `tsc` does not see and `@typescript-eslint/no-floating-promises`
  does. On the Python side the tool handlers return `dict[str, Any]` throughout
  (`assistant/tools.py`), so the type checker would be the only reader of those shapes. Silenced
  deprecations compound finding 2: an unlocked dependency can deprecate and then remove an API
  with no warning shown.
- **Proposal.** Add `typescript-eslint` with the type-aware promise rules only (not a style
  crusade), run `mypy app` in CI starting non-blocking to see the count, and narrow the
  deprecation filter to the libraries that are known to be noisy.
- **Effort.** S each.

### 9. No browser-level test; UI verification is manual and visibly behind — Medium

- **Evidence.** No Playwright or Cypress in any manifest. The web suite is 76 jsdom/node files
  (`apps/web/vitest.config.ts:5-7`); the only end-to-end gate is `scripts/smoke-test.sh` (183
  lines, API-level). The debt table already carries the consequence: "The template creator's UI
  has not been seen in a browser" and "Few component/DOM tests on the web app"
  (`.claude/MEMORY.md:7700-7817`).
- **Cost.** RTL mirroring, the phone layout and the installable shell are the areas with the most
  recent churn and they are checked by a person, when remembered. jsdom cannot see layout.
- **Proposal.** One Playwright job against the compose stack CI already starts: sign in, add a
  holding, open a proposal, approve it, in English and Hebrew at 375 px and desktop, with
  screenshots kept as artifacts. Five flows, not a suite. This is a new dev dependency: the
  owner's call under convention 5.
- **Effort.** M.

### 10. Four hot spots worth splitting — Medium/Low

- **Evidence.** `handleCallback` runs from line 487 to 760 of
  `apps/orchestrator/src/telegram/updates.ts` (about 274 lines, one function deciding every signed
  button). `apps/web/src/pages/AdminPage.tsx` is 1,192 lines holding about 30 components.
  `services/ai/app/assistant/tools.py` is 1,303 lines: twelve tools, each with its own SQL.
  `apps/orchestrator/src/notify/messages.ts` is 1,690 lines and its header still justifies a typed
  record over a catalogue because "this has a few dozen" sentences (`:6-10`).
- **Cost.** These are where parallel sessions collide and where a review cannot hold the whole
  unit in view. The Telegram handler is the one that approves trades.
- **Proposal.** A handler table keyed by callback action for `handleCallback`; one file per Admin
  card; one module per assistant tool with the SQL moved to a `queries` module per concept
  (mirroring the orchestrator's rule, which the Python side does not have: SQL appears in 54
  files under `services/ai/app`); split `messages.ts` by surface (digest, Telegram, notices) and
  correct its header.
- **Effort.** M in total, each piece S.

### 11. A run kind is declared in four places — Low

- **Evidence.** `RUN_BUCKET_MINUTES` (`apps/orchestrator/src/http/routes/internal.ts:66-99`), the
  zod enum (`:131-144`), `INSTALLATION_KINDS`/`USER_KINDS` (`src/runKinds.ts:22-40`) and an
  `if (kind === ...)` chain whose final branch is `news_collect` by elimination (`:204-290`).
  Unknown kinds silently get a daily bucket (`:114`, `?? 24 * 60`).
- **Cost.** Adding a kind means four edits; forgetting the `if` sends the new kind down the
  news-collection path. The contract test (`test_run_kinds_contract.py`) guards the CronJob side,
  not this.
- **Proposal.** One `Record<RunKind, { bucketMinutes, scope, retryFailed, run }>`; derive the enum
  and the sets from its keys so the compiler enforces completeness.
- **Effort.** S.

### 12. Guideline 6 is true at call sites and no longer true of the product — Low

- **Evidence.** Callers do get an `LLMProvider`, but OpenRouter is named in 22 Python files and 34
  TypeScript files: users' own keys, the live model list, credits, the safety limit (D206, D211,
  D247, D283; `factory.py:56-63` says "Only for OpenRouter"). Market data has two implementations
  while config keeps key slots for Polygon, Finnhub and CoinGecko
  (`services/ai/app/config.py:112-115`; D288 already has the Keys tab say "which nothing uses").
  The universe is Yahoo-specific by construction (`app/universe/screener.py:81`, `:95`).
- **View.** I agree with the decisions - binding the product to OpenRouter bought per-user keys
  and pricing for free. The problem is only that CLAUDE.md still states "adding a provider must
  never touch a call site" as non-negotiable, which a session will spend effort honouring.
- **Proposal.** Reword guideline 6 to what is enforced: price, news and embedding reads go through
  their interfaces; the LLM vendor is OpenRouter by decision. Remove the unused key settings.
- **Effort.** S.

### 13. Known debt I would pull forward — Low

Already recorded; cited so they are not mistaken for discoveries. I agree with each as written.

- **A cash movement has no idempotency key** (`.claude/MEMORY.md:5921`): a retried request records
  a deposit twice. Trades already take a key (`http/routes/trades.ts:42`, `:80`); movements should
  copy it. S.
- **Import previews live in process memory** (`MEMORY.md:7767`, `services/previewStore.ts`): pins
  the orchestrator to one replica and a `Recreate` deploy. Redis is already a dependency. S-M.
- **The assistant eval runs only by hand** (`MEMORY.md:7721`): prompt and tool changes can regress
  unseen. A recorded-transcript tier (replaying stored model answers through the validator) would
  be free and hermetic. M.

## Unverified

- **True SQL coverage.** The "56 of 215 not named" figure is a name grep, not execution. Settle
  it: run the `postgres (integration)` job with `vitest run --coverage
  --coverage.include='src/db/queries/**'`.
- **Whether Ask and the Agents page can actually disagree.** The two formulas differ on paper
  (budget against deposits; three rounding rules). Whether `agents.budget_minor` always equals
  the deposits sum after a cash movement decides it. Settle it: on a `_test` database, give a
  simulated agent a deposit and a fractional-cent valuation, then compare `get_agents` with
  `GET /agents/:id/performance`.
- **Whether float valuation has ever produced a wrong cent.** Settle it: a property test of
  `scaleMinor` against a `bigint` reference over random 18-decimal quantities and realistic prices.
- **How many errors `mypy` reports today.** Settle it: `cd services/ai && .venv/bin/mypy app`.
- **Dependency age and advisories.** Needs the network: `pnpm outdated -r`, `pnpm audit`,
  `uv pip list --outdated`. Vite 5 / Vitest 2 / React 18 / zod 3 are each a major version behind
  what their ecosystems had moved to; whether any of that matters here was not checked.
- **Test flakiness in practice.** Both vitest configs record past timeouts from CPU
  oversubscription (`apps/web/vitest.config.ts:9-11`, `apps/orchestrator/vitest.config.ts:8-10`),
  and about 90 test lines use the wall clock (mostly relative offsets, which is fine). Whether
  anything still flakes needs CI history: `gh run list --workflow CI --status failure`.
- **Whether a run can outlive its HTTP request.** Scheduled work executes inside the
  `POST /internal/runs` request (`internal.ts:164-190`). Whether the CronJob's client timeout is
  shorter than the longest run (news collection is recorded at about 6 minutes for 500
  instruments) was not checked: compare the `curl --max-time` in
  `infra/k8s/base/cronjobs.yaml` with the slowest `runs.finished_at - started_at` per kind.
