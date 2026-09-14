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
bash scripts/dev-docker.sh
```

That is the whole setup: it creates `.env` with generated secrets on first run, builds the
images, starts everything, waits until the stack is genuinely ready, and prints the dashboard URL
and your sign-in passphrase. Then import `data/fixtures/demo-portfolio.csv`.

### Two ways to run it

| | `scripts/dev-docker.sh` | `scripts/dev-local.sh` |
|---|---|---|
| **Use when** | demoing, infrastructure work, migrations, anything CI must match | writing application code, debugging, fastest iteration |
| Runs in containers | everything | Postgres and Redis only |
| Runs on your Mac | nothing | the three application processes |
| Reload speed | seconds (rebuild) | instant (native watch) |
| Needs installed | Docker | Docker, pnpm, uv |

Both read the same `.env` and share one database, so you can switch between them freely.
`--help` on either explains its options.

No API keys are needed: the default provider chain starts with a fixture provider, so the whole
system runs offline. Set `MARKET_DATA_PROVIDERS=yfinance,fixture` in `.env` to prefer live
(delayed) Yahoo Finance prices.

| Service | Default URL |
|---|---|
| Web dashboard | http://127.0.0.1:5173 |
| Orchestrator API | http://127.0.0.1:8080 (`/healthz`, `/readyz`) |
| AI service | http://127.0.0.1:8000 (`/docs`) |

Every published port is configurable in `.env` (`WEB_HOST_PORT`, `ORCHESTRATOR_HOST_PORT`,
`AI_SERVICE_HOST_PORT`, `POSTGRES_HOST_PORT`, `REDIS_HOST_PORT`) for when another project on your
machine already owns one. Only the host side moves; the ports inside Docker never change. Prefer
`127.0.0.1` over `localhost`: on macOS `localhost` resolves to IPv6 first, which may be a
different process entirely.

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
scripts             dev-docker.sh, dev-local.sh, smoke-test.sh
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
