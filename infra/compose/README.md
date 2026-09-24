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

`universe` is a third, the same shape: it loads the instrument universe (`data/universe`) that topic
resolution searches. Membership and ETF holdings are committed and in the image. The descriptions
are not, because they are Yahoo's text and licensed per installation. The checkout's
`data/universe` is mounted read-only into this container, so a local `descriptions.local.jsonl`
reaches the loader that way. **With no such file it exits 0 having profiled nothing**, and
`POST /topics/resolve` then answers `verdict: unavailable` with `universe.state: not_loaded`. The
first run with the file takes about 45 s plus embedding (about two minutes and two cents on the
OpenRouter embedder). Later starts take about 20 s and embed nothing.

Fully offline run (no Yahoo Finance calls): set `MARKET_DATA_PROVIDERS=fixture` in `.env`.
