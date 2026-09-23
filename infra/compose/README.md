# Compose environment

```bash
cp .env.example .env      # once, from the repository root
pnpm up                   # docker compose up --build
```

| Service | URL | Notes |
|---|---|---|
| web | http://localhost:5173 | Vite dev server (hot reload) |
| orchestrator | http://localhost:8080 | REST API; `/healthz`, `/readyz` |
| ai-service | http://localhost:8000 | `/docs` for the OpenAPI explorer |
| postgres | localhost:5432 | pgvector image, data in a named volume |
| redis | localhost:6379 | provider cache and rate limiting |

`migrate` is a one-shot Alembic container: the two services wait for it to finish
successfully before starting, so a schema change can never race the code that uses it.

`corpus` is a second one-shot container, after `migrate`, that loads `data/corpus`
into the knowledge-base tables. Nothing waits on it: an empty corpus costs the
concept links in the observations feed and nothing else, so a document that fails
to parse must not keep the app down. Check for it as `Exited (1)` in `compose ps`.
Re-running is free - each document is compared by content hash and rewritten only
when it changed.

Fully offline run (no Yahoo Finance calls): set `MARKET_DATA_PROVIDERS=fixture` in `.env`.
