# CLAUDE.md — working agreement for this repository

Project: **Traders — AI Financial Advisor & Portfolio Copilot**.
Read [docs/PRD.md](docs/PRD.md), [docs/DESIGN.md](docs/DESIGN.md), [docs/FLOWS.md](docs/FLOWS.md)
and [docs/MILESTONES.md](docs/MILESTONES.md) before changing architecture.

---

## Project guidelines (non-negotiable)

1. **English only.** All code, identifiers, comments, docstrings, commit messages, documentation
   and UI copy.
2. **No order execution, ever.** Approvals write to the virtual ledger only. No broker API, no
   personalized investment advice; output is observation + explanation.
3. **Money is integer minor units plus an explicit currency code.** `Decimal` in Python, integer
   arithmetic in TypeScript, rounding exactly once at the boundary. Never a float. Cost basis is
   stored **per unit**; totals are computed at read time.
4. **Quantities cross the wire as decimal strings**; `numeric(38, 18)` in Postgres.
5. **Every user-owned table carries `user_id`**, even though v1 ships a single account.
6. **External dependencies sit behind interfaces**: `MarketDataProvider`, `NewsProvider`,
   `VectorStore`, the LLM provider factory. Adding a provider must never touch a call site.
7. **Nothing is invented.** An unavailable price is `null` and is reported as unpriced — never
   zero, never hidden. Figures in generated text come from structured evidence, never from a
   model; the evidence validator rejects unsourced numbers.
8. **Runs are idempotent.** Scheduled work enters through `POST /internal/runs` with a run key;
   observations and notifications carry a `dedupe_key`.
9. **Secrets live in `.env` / Kubernetes Secrets only.** Never committed, never logged, never
   shipped to the browser.
10. **Timestamps are ISO 8601 UTC**; "today" resolves in the user's timezone (`APP_TIMEZONE`,
    default `Asia/Jerusalem`). Base currency USD.

## Conventions learned the hard way

Each of these cost real time. They are listed so the cost is paid once.

1. **Tests assert constants, never tuning values.** `assert ttl == CRYPTO_TTL_SECONDS`, not
   `== 60`. Three separate spurious failures came from a test about session boundaries breaking
   because an unrelated TTL was retuned. A test should fail when the behaviour it describes
   changes, and at no other time.
2. **No stacked pull requests.** One branch off `main`, merged, then the next. Two PRs merged into
   their base branches instead of `main` and their content silently never arrived - while GitHub
   displayed them as MERGED. Parallel authoring in separate worktrees is fine; parallel merging is
   not. After merging, verify by content (`grep` for a marker), not by the merge badge.
3. **Tests must not read `.env`.** Build settings with `_env_file=None` and override injected
   config. A test whose result depends on a file outside the repository passes on one machine and
   fails on another, and the green one is the misleading result.
4. **Name modules after the concept they own.** `money.ts`, `valuation.ts`, `cache_policy.py` - no
   `utils`, `helpers`, `common` or `misc` filenames. A file whose only honest name is "utils" has
   contents that do not belong together.

## Repository conventions

- Monorepo: `apps/web`, `apps/orchestrator`, `packages/shared`, `services/ai`, `infra/*`.
- The AI service owns the schema (Alembic). The orchestrator reads/writes the same tables through
  hand-written SQL in `src/db/queries.ts` — all SQL lives in that one file.
- The TypeScript AI client is generated from the committed `services/ai/openapi.json`. After
  changing a pydantic wire model: `python scripts/export_openapi.py && pnpm gen:api`, and commit
  both.
- Tests must be hermetic: the fixture provider means no network and no API keys in CI.

## Session management & handoff

`.claude/MEMORY.md` is the handoff document. It is written for a session that has never seen the
conversation that produced the code: the code is readable, the reasoning behind it is not, and the
reasoning is the part that is lost when a session ends.

### When to hand off

**At a milestone boundary, or after five merged PRs — whichever comes first.** Not "when the
context window saturates": that was the rule for twenty-three PRs and it never once fired, because
nothing counts a feeling. These triggers are countable, so they can be obeyed or visibly broken.

A handoff is three steps, in order:

1. Update `.claude/MEMORY.md` — milestone status, decisions argued rather than obvious and *why*,
   bugs that cost real time and the lesson from each, current debt, and anything about the local
   environment that would waste an hour to rediscover.
2. Commit it, open a PR, and stop.
3. Tell the user to start a fresh session, and say what the next milestone is.

### What belongs in MEMORY.md

The test is whether a capable stranger with the repository would otherwise have to re-derive it.

- **Decisions with their alternatives and the failure they prevent.** "We rejected X because Y
  fails in the expensive direction" is worth ten lines of what the code already shows.
- **Bugs whose lesson generalises**, written as the lesson. A bug nobody can learn from is
  `git log` material, not memory.
- **Debt as consequences**, not as a wish list: what breaks, and for whom.
- **Deliberate asymmetries** — a local `.env` that differs from `.env.example` on purpose, an
  exception to a convention - so the next session does not "fix" them.

Not: what the code says, what a test asserts, or anything a `grep` would answer faster.

## Quality Assurance, Pre-PR Checklist & Interactive Learning Quiz

Before declaring any milestone complete or preparing a PR, run a self-audit and learning
verification covering:

1. **Constraint audit**: verify strict adherence to project guidelines (English only, integer
   minor units / `Decimal` for money, proper interfaces, `user_id` columns).
2. **Automated testing**: run the full test suite (FastAPI pytest / frontend tests) to ensure zero
   regressions.
3. **Security check**: verify that no secrets, credentials, or `.env` files are tracked in git.
4. **Learning quiz - on request only**:
   - When the user asks for a quiz, generate 3 to 5 questions on the new code, the architectural
     choices and the edge cases, ask them one at a time, and wait for each answer.
   - Do not gate commits, PRs or milestones on it. It was blocking delivery and being skipped, and
     a rule that is routinely skipped teaches nothing except that rules are optional.
   - Instead, every PR body explains what changed and why it matters. That is the durable version
     of the same idea, and it survives in the repository rather than in a terminal.

### Commands the audit uses

```bash
pnpm -r typecheck && pnpm -r test          # TypeScript: web, orchestrator, shared
cd services/ai && .venv/bin/pytest -q      # Python
.venv/bin/ruff check . && .venv/bin/ruff format --check .
bash scripts/smoke-test.sh                 # end-to-end, against a running stack
git ls-files | grep -E '(^|/)\.env' || echo "no .env tracked"
```
