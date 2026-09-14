# Traders — AI Financial Advisor & Portfolio Copilot

Portfolio tracking with **explained observations**. The system watches your holdings and the
themes you care about, and tells you what moved and why — with the data and sources behind every
claim. It never places an order.

> **Educational and informational only.** Nothing this system produces is investment advice.
> Approved recommendations are recorded in a virtual ledger so their accuracy can be tracked over
> time; no broker is ever contacted. Prices may be delayed.

| Document | What it covers |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Problem, product stances, functional requirements, success criteria |
| [docs/DESIGN.md](docs/DESIGN.md) | Architecture, decisions and rejected alternatives, data model, security |
| [docs/FLOWS.md](docs/FLOWS.md) | Diagrams for import, scheduled runs, HITL, Telegram, topics, RAG |
| [docs/MILESTONES.md](docs/MILESTONES.md) | Milestone plan with exit criteria |

---

## Quick start

```bash
cp .env.example .env
# set APP_PASSPHRASE and SESSION_SECRET to your own values
pnpm up
```

Then open **http://localhost:5173**, sign in with `APP_PASSPHRASE`, and import
`data/fixtures/demo-portfolio.csv`.

No API keys are needed: the default provider chain starts with a fixture provider, so the whole
system runs offline. Set `MARKET_DATA_PROVIDERS=yfinance,fixture` in `.env` to prefer live
(delayed) Yahoo Finance prices.

| Service | URL |
|---|---|
| Web dashboard | http://localhost:5173 |
| Orchestrator API | http://localhost:8080 (`/healthz`, `/readyz`) |
| AI service | http://localhost:8000 (`/docs`) |

## Architecture at a glance

```
  Browser ──► orchestrator (Node/TS, Hono)  ──REST──►  ai-service (Python, FastAPI)
                    │   sessions, holdings,                 │  provider chain, cache,
                    │   import, valuation,                  │  rate limiting, (M2) analysis,
                    │   runs, (M4) workflows + Telegram      │  (M3) RAG
                    └──────────► Postgres + pgvector ◄───────┘
                                      Redis
```

Three services, one Postgres (schema owned by Alembic in `services/ai`), one Redis. See
[docs/DESIGN.md](docs/DESIGN.md) for why each choice was made.

## Repository layout

```
apps/web            React + MobX + Tailwind dashboard (Vite)
apps/orchestrator   REST API, valuation, import, scheduled-run entrypoint
packages/shared     Shared types, money helpers, generated AI-service client
services/ai         FastAPI service: market data providers, migrations
infra/docker        Dockerfiles
infra/compose       local docker-compose environment
infra/k8s           Kubernetes manifests (Milestone 7)
data/fixtures       offline prices, instruments and a demo portfolio
scripts             smoke-test.sh (end-to-end check against a running stack)
```

## Development

```bash
pnpm install                       # workspace dependencies
pnpm -r typecheck                  # TypeScript across web, orchestrator, shared
pnpm -r test                       # vitest suites
pnpm gen:api                       # regenerate the AI-service client from openapi.json

cd services/ai
uv venv --python 3.12 && uv pip install -e '.[dev]'
.venv/bin/pytest -q                # hermetic: fixture provider, no network
.venv/bin/ruff check . && .venv/bin/ruff format .
python scripts/export_openapi.py   # after changing any pydantic wire model
```

`bash scripts/smoke-test.sh` runs the full vertical slice against a live stack: login, import,
valuation, snapshot run, and the idempotency and auth checks. CI runs it on every push.

## Conventions

- **Money** is integer minor units plus an explicit currency code, everywhere. Never a float.
  Cost basis is stored **per unit**; totals are computed at read time.
- **Quantities** cross the wire as decimal strings so fractional crypto stays exact.
- **Timestamps** are ISO 8601 UTC; "today" is resolved in the user's timezone (`APP_TIMEZONE`,
  default `Asia/Jerusalem`).
- **Nothing is invented.** A price nobody can provide is `null` and is reported as unpriced — never
  zero, never hidden. Figures in generated text come from structured data, never from a model.
- **Runs are idempotent.** Scheduled work enters through `POST /internal/runs` with a run key, so a
  double trigger is a no-op.
- **English only** in code, comments, commits and documentation.

## Status

Milestones 0 and 1 are complete: repo skeleton, containerised environment, provider chain with
caching and fallback, portfolio import with per-row validation, valuation with FX, the dashboard,
and the daily snapshot job. Milestone 2 (analysis engine and observations) is next — see
[docs/MILESTONES.md](docs/MILESTONES.md).
