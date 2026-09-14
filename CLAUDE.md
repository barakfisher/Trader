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

## Repository conventions

- Monorepo: `apps/web`, `apps/orchestrator`, `packages/shared`, `services/ai`, `infra/*`.
- The AI service owns the schema (Alembic). The orchestrator reads/writes the same tables through
  hand-written SQL in `src/db/queries.ts` — all SQL lives in that one file.
- The TypeScript AI client is generated from the committed `services/ai/openapi.json`. After
  changing a pydantic wire model: `python scripts/export_openapi.py && pnpm gen:api`, and commit
  both.
- Tests must be hermetic: the fixture provider means no network and no API keys in CI.

## Session management & memory

1. **Memory file**: maintain [`.claude/MEMORY.md`](.claude/MEMORY.md). At the end of every feature
   or milestone, update it with:
   - completed features and current milestone status,
   - architectural decisions made,
   - known issues and pending technical debt.
2. **Context housekeeping**: if a task runs long or the context window saturates, update
   `MEMORY.md` first, then tell the user to run `/compact` or start a fresh session.

## Quality Assurance, Pre-PR Checklist & Interactive Learning Quiz

Before declaring any milestone complete or preparing a PR, run a self-audit and learning
verification covering:

1. **Constraint audit**: verify strict adherence to project guidelines (English only, integer
   minor units / `Decimal` for money, proper interfaces, `user_id` columns).
2. **Automated testing**: run the full test suite (FastAPI pytest / frontend tests) to ensure zero
   regressions.
3. **Security check**: verify that no secrets, credentials, or `.env` files are tracked in git.
4. **Interactive milestone learning quiz**:
   - Generate a 3 to 5 question quiz directly in the CLI/terminal covering the new code changes,
     architectural choices, and potential edge cases introduced in this milestone.
   - Present the quiz to the user and **wait for their responses** before wrapping up the
     milestone, creating a git commit, or opening a PR.

### Commands the audit uses

```bash
pnpm -r typecheck && pnpm -r test          # TypeScript: web, orchestrator, shared
cd services/ai && .venv/bin/pytest -q      # Python
.venv/bin/ruff check . && .venv/bin/ruff format --check .
bash scripts/smoke-test.sh                 # end-to-end, against a running stack
git ls-files | grep -E '(^|/)\.env' || echo "no .env tracked"
```
