# Mastra workflows

This directory is where the Mastra orchestration layer lands in **Milestone 4**:

- `portfolioScan`, `topicScan`, `dailyDigest` workflows,
- `proposalLifecycle` with `suspend`/`resume` for human-in-the-loop approval,
- the Telegram bot integration.

It is intentionally empty in M1. The milestone's deliverable is a working vertical
slice (portfolio in, valued portfolio out), and a workflow engine with no
observations to act on cannot be tested against anything real. The pieces M4
needs are already in place and shaped for it:

| M4 needs | Already exists |
|---|---|
| a single trigger entrypoint | `POST /internal/runs` in `src/http/routes/internal.ts` |
| idempotent runs | run-key deduplication in the same file (moves to the `runs` table) |
| durable state for suspended workflows | Postgres, schema owned by Alembic |
| a market-data and news boundary | `AiClient` in `packages/shared` |

Adding `@mastra/core` before there are workflows to register would mean carrying a
dependency that nothing imports, so it is installed in M4 together with the first
workflow.
