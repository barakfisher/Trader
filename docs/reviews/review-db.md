# Review — Database (2026-11-10)

Role: senior PostgreSQL engineer. Read from source at `95e4c6e` (86 Alembic revisions, the
orchestrator's `src/db/queries/`, the Python query code, the scripts and the runbook).
**The local compose database was not running** (`docker ps -a` listed no `traders-postgres-1`;
only `traders-agents-ci`, exited), so nothing here is measured: no `EXPLAIN`, no
`pg_stat_user_indexes`, no row counts. Everything that needs a live database is under
*Unverified* with the query that settles it.

## Summary (5 lines max)

- The schema is unusually strong: invariants live in the database (CHECKs, composite FKs,
  append-only triggers, partial uniques), and the ledger's concurrency is correct by construction.
- The weak side is operations, not design: production's only backup depends on a laptop being
  awake, and a deploy migrates without a fresh dump although rollback across a migration needs one.
- No statement, lock or idle-in-transaction timeout exists anywhere, and three code paths hold a
  transaction open across network calls; D377's 22-minute stall is that combination.
- Retention and index decisions (D141, D151, D153) were measured before public signup and the
  5,223-profile load; their own "revisit on a trigger" conditions need re-reading on production.
- Nothing found that corrupts money or breaks idempotency.

## What is strong and should stay

- **Idempotency is enforced by the database, not by code.** `runs (agent_id, run_key) NULLS NOT
  DISTINCT` (`0036_agents.py:70`, claimed by `INSERT ... ON CONFLICT DO NOTHING`,
  `apps/orchestrator/src/db/queries/runs.ts:76-83`); `fills_agent_idempotency_key` and
  `fills_one_per_proposal` (`0040_ledger.py:111-112`); `observations.dedupe_key`;
  `agent_scans_one_running` partial unique (`0043_agent_scans.py:80-83`).
- **The ledger.** `notional_minor = quantity * price_minor` as a CHECK, `balance_minor >= 0` as a
  CHECK, whole shares as a CHECK, movements written only by `SECURITY DEFINER` triggers, fills
  append-only for the owner too, `traders_app` unable to write cash at all (`0040_ledger.py:72-200`).
  The application takes `SELECT ... FOR UPDATE` on the cash row, re-checks the idempotency key under
  the lock, and still maps the database's own refusal (`services/fills.ts:430-505`,
  `db/queries/ledger.ts:118,170`).
- **Double approval is a compare-and-set**, `UPDATE proposals ... AND state = $6`, with the audit
  row, the intent and (for a trade) the fill in one transaction (`db/queries/proposals.ts:231-262`).
- **Tenant integrity in the keys**: composite FKs `(user_id, agent_id) REFERENCES agents (user_id,
  id)` make a cross-user reference unrepresentable (`0040_ledger.py:77-78,103-104,127-128`).
- **Limits under concurrency**: the agent-limit triggers lock the user row before counting
  (`0047_agent_limit.py:75`, `0062_active_agent_limit.py:49,84`).
- **Types**: every money column is `bigint` minor units, every timestamp `timestamptz`; no float,
  no `timestamp`, no integer money column in any migration (grep over `alembic/versions`).
- **Account erase as a function** (`erase_account`, 0076) instead of cascades that would hand the
  app role the history it was denied. I agree with that reasoning.
- **Migration testing over data**: `tests/integration/test_migrations.py` round-trips every
  revision over `seed_head.sql`, which must carry a row for every CHECK-enumerated value.
- **Backups verified at write time and drilled**: a dump is named final only after it is read back,
  and `db-restore.sh --drill` restores into a scratch database and compares counts.
- **SQL in one directory, tested against real Postgres** (`test/queries.postgres.test.ts`, 3,640
  lines, required in CI by `INTEGRATION_REQUIRED`). D144 (`IS NOT DISTINCT FROM` rewritten), D152
  and D377 are the right calls and well argued.

## Findings (ranked)

### 1. Production's only backup needs the Mac awake; no second copy, no PITR, unencrypted — High

- **Evidence.** `docs/RUNBOOK.md:314-316`: "Off-host only while the Mac is on: a copy in OCI Object
  Storage is the next PR". D348 (2026-10-29) staged it "so the backup no longer depends on the Mac
  being awake before strangers sign up"; no object-storage step exists in `scripts/` today, and
  signup is public. `scripts/db-backup.sh:113` is a plain `pg_dump --format=custom` into
  `~/Backups/traders` (mode 700, not encrypted). PITR was rejected in the DB sprint
  (`.claude/MEMORY.md:9354-9356`) "for a database whose lost day costs one day of simulated history".
- **Failure.** Laptop closed for a weekend plus a lost VM volume = days of every user's data gone.
  The dump holds password hashes, session-token hashes, emails and the encrypted LLM keys in clear
  files on one disk. The PITR rejection's premise no longer holds: the database now carries the
  real portfolio's cash ledger (0078, 0080) and other people's accounts, entered by hand.
- **Improvement.** Land D348's second half: a server-side nightly `pg_dump` pushed to object
  storage, encrypted client-side (`age` or `gpg`) before it leaves the host, with the same
  read-back check. Keep the Mac pull as the second copy. I agree with D137 (never the same failure
  domain) and with staging; I disagree that it can stay staged. PITR (WAL archiving to the same
  bucket) is a separate, later question: state the accepted RPO (24 h today) in the runbook so it
  is a decision rather than a default.
- **Effort.** M.

### 2. A deploy migrates with no fresh backup, and rollback across a migration needs one — High

- **Evidence.** `scripts/prod-deploy.sh:1-90` checks out, builds and runs `up -d` (migrate first);
  it contains no backup step. `docs/RUNBOOK.md:308-309`: going back is deploying the earlier commit
  "except across a migration: Alembic does not run downgrades here, so an older commit on a newer
  schema needs the restore below". The "compose first, backup, then prod" order is a habit, not
  something the script enforces.
- **Failure.** A migration that succeeds but ships a bad release leaves one way back: restore the
  newest dump, up to 24 h old (older if the Mac slept), losing every write since.
- **Improvement.** `prod-deploy.sh` runs `db-backup.sh --target prod` (or a server-side dump) when
  the target commit's Alembic head differs from the deployed one, and refuses to continue if it
  fails; `--no-backup` to skip by name, as `k8s-down.sh` already does.
- **Effort.** S.

### 3. No timeouts anywhere, and transactions are held open across network calls — High

- **Evidence.** `grep -rn 'statement_timeout|idle_in_transaction|lock_timeout'` over the code,
  compose files and scripts returns nothing but two lines of MEMORY.md. Pools:
  `apps/orchestrator/src/db/pool.ts:17-22` (max 10, no `statement_timeout`), and
  `services/ai/app/db.py:23` (`create_engine(url, pool_pre_ping=True)`, defaults 5 + 10 overflow).
  Transactions spanning awaited I/O: `services/ai/app/routers/analysis.py:67` (`engine.begin()`
  around `run_portfolio_scan`, which calls the LLM), `routers/news.py:42` (around provider
  fetches), `news/on_demand.py:108`. The driver is synchronous inside `async def` routes, so a slow
  statement blocks the event loop; D377 measured exactly this (1,357 s prune, a 660 s lock wait, the
  120 s limit unable to cancel) and noted moving the fetch out of the transaction was "worth doing".
- **Failure.** One slow statement or stuck provider stalls the whole AI service (single uvicorn
  process, `infra/docker/Dockerfile.ai:60`), holds a snapshot that stops vacuum, and makes any DDL
  in a deploy queue behind it with every other query on that table queued behind the DDL.
- **Improvement.** (a) Role-level defaults in a migration: `ALTER ROLE traders_app SET
  statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` (generous: 60 s / 5 s /
  5 min), overridden per statement where a long one is legitimate. (b) `SET lock_timeout` at the top
  of the migration run so a blocked DDL fails instead of queueing traffic. (c) Fetch and narrate
  first, open the transaction only to write. D377 rejected timeouts as the *only* fix, rightly;
  they are still the missing backstop. (d) Set `application_name` per service: both connect as
  `traders_app`, so `pg_stat_activity` cannot tell them apart today.
- **Effort.** S for (a), (b), (d); M for (c).

### 4. Retention was decided at pre-public volumes; several tables grow without bound — Med

- **Evidence.** D141 (2026-10-09): "at the measured volumes no table needs a retention policy";
  D153 gives `runs` a trigger (50 MB or 100k rows). Since then: public signup, per-user agents,
  the assistant, 5,223 profiles. Every `DELETE` in both services was listed: only `llm_calls`,
  `articles`, sessions, tokens and user-initiated deletes prune. Nothing prunes `quotes` (written
  on every portfolio read, `http/routes/portfolio.ts:78`, plus backfills), `agent_scans` (`briefing`
  and `transcript` jsonb per scan, `0043_agent_scans.py:68-69`; the app role cannot delete them),
  `observations`, `notifications`, `proposal_transitions`, `assistant_messages`.
- **Failure.** Not an outage soon; the cost is dump size and restore time growing with the two
  tables that store whole documents per row, and nobody being told when a trigger is crossed.
- **Improvement.** I agree with D141's method (measure, then decide). Re-run `db-report.sh` on
  production, and give each growing table what D153 gave `runs`: a size and a row trigger, written
  down. Likely outcomes: collapse intraday `quotes` older than N days to the daily close the
  analysis already reads; null out `agent_scans.transcript` past a window while keeping the row.
  Have `db-report.sh` print the triggers and whether each is crossed.
- **Effort.** S to measure and record; M per table that needs a policy.

### 5. The schema has no single readable form — Med

- **Evidence.** `services/ai/app/models.py` holds pydantic wire models, not tables; `alembic/env.py`
  sets no `target_metadata`. The schema exists only as 86 raw-SQL revisions (9,334 lines) or a
  running database. `runs_kind_check` alone is rewritten in 14 revisions, each re-listing the
  previous kinds by hand. The orchestrator's row interfaces are hand-declared against it.
- **Failure.** Answering "what constraints does `proposals` have today?" means replaying history in
  your head or starting a stack; a DDL change is reviewed as a delta with no view of the result.
  This review could not see current indexes for that reason.
- **Improvement.** Commit `docs/schema.sql` from `pg_dump --schema-only --no-owner` at head, and
  have the existing CI Postgres job fail when it differs from a fresh dump. Diffs then show the
  resulting schema in every migration PR. No ORM needed; D142's split stays.
- **Effort.** S.

### 6. `quotes_recent_idx` duplicates the primary key — Low

- **Evidence.** `0001_initial_portfolio.py:101,105`: `PRIMARY KEY (instrument_id, as_of)` and
  `CREATE INDEX quotes_recent_idx ON quotes (instrument_id, as_of DESC)`; no later revision drops
  it (grep). A btree is scanned backwards, so the primary key serves `ORDER BY as_of DESC` per
  instrument equally.
- **Failure.** Every quote insert maintains two identical indexes on the fastest-growing table.
- **Improvement.** Confirm with `pg_stat_user_indexes` and an `EXPLAIN` of the three reads in
  `services/ai/app/analysis/quote_history.py:33-64`, then drop it, as D152 did for its two.
- **Effort.** S.

### 7. A reclaimed run has no fencing — Low

- **Evidence.** `runs.ts:107-128` reclaims a `running` row after 30 minutes by `UPDATE` on the same
  id; `finishRun` is `UPDATE runs SET status ... WHERE id = $1` (`runs.ts:181-191`) with no check
  that the caller still owns the claim.
- **Failure.** A run that is slow, not dead (an LLM provider hanging past 30 minutes), is taken
  over; both workers do the work, and the first to finish marks the run finished while the second
  is still writing. Downstream uniques stop duplicate observations and fills, so the damage is
  double spend on model calls and a run row whose stats describe the wrong attempt.
- **Improvement.** An `attempt` counter incremented by the reclaim and required by `finishRun`
  (`WHERE id = $1 AND attempt = $n`), or extend the existing heartbeat (0031) to every kind that
  calls a model.
- **Effort.** S.

### 8. `transaction()` can lose the real error and return a broken connection — Low

- **Evidence.** `apps/orchestrator/src/db/pool.ts:54-59`: the `catch` awaits `ROLLBACK` before
  rethrowing, and `finally` calls `client.release()` with no argument.
- **Failure.** When the connection itself died, `ROLLBACK` throws, the original error is replaced
  by a socket error, and the dead client goes back to the pool for the next caller.
- **Improvement.** Wrap the rollback in its own try/catch, and `client.release(error)` when it
  failed so `pg` discards the connection.
- **Effort.** S.

### 9. Production Postgres runs on defaults, from a floating image tag — Low

- **Evidence.** `infra/compose/docker-compose.prod.yml:46-58`: `image: pgvector/pgvector:pg16`, and
  the only flags are `pg_stat_statements`, `log_min_duration_statement=200`, `log_lock_waits=on`.
  `shared_buffers` is therefore 128 MB and no checkpoint or autovacuum logging is on.
- **Failure.** A rebuild can pull a different minor version or pgvector release than the one the
  dumps were verified against; sizing is whatever the image ships.
- **Improvement.** Pin the tag to a pgvector release (or a digest); set `shared_buffers` to about a
  quarter of the VM's memory and `log_autovacuum_min_duration=0`, `log_checkpoints=on`.
- **Effort.** S.

### 10. D151 dropped the profiles HNSW index at 200 rows; production now has 5,223 — Low

- **Evidence.** `0053_drop_profiles_hnsw.py:1-13` (exact scan beat the index at 200 rows);
  `app/universe/profiles.py:495-500,799` orders by `embedding <=> :q` with no index. `kb_chunks`
  has no ANN index either (`0013_kb_embeddings.py`), which is right for a corpus of that size.
- **Failure.** None expected yet: an exact scan over about 5k 1536-wide vectors is tens of
  milliseconds. It is a decision whose measured premise changed by 25x.
- **Improvement.** I agree with D151. Re-measure `search_profiles` on production once and record a
  trigger (for example p95 over 200 ms, or 50k rows) for bringing HNSW back with `ef_search` raised.
- **Effort.** S.

## Unverified

Each needs the database this review could not reach. Run against compose, or SELECT-only on
production.

- **Foreign keys without an index on the referencing column.** D377 counted "16 more ... all on
  small tables". Since then `fills`, `cash_movements`, `agent_scans`, `proposal_attempts` have
  grown and `erase_account` deletes through them. Check: join `pg_constraint (contype = 'f')` to
  `pg_index` on leading columns and list those with no match, with `pg_class.reltuples`.
- **Unused or overlapping indexes on `llm_calls`.** Six were created across 0029, 0041, 0042, 0052
  and 0064, two of them on `(user_id, started_at)`. Check: `pg_stat_user_indexes` for `llm_calls`
  after a week; `\d llm_calls` for the partial predicates.
- **Whether `runs` has crossed D153's trigger** (50 MB or 100k rows) on production. Check:
  `bash scripts/db-report.sh` there, or `SELECT pg_total_relation_size('runs'), reltuples FROM
  pg_class WHERE relname = 'runs'`.
- **Sizes of `quotes`, `agent_scans`, `observations`, `assistant_messages`** (finding 4). Check:
  `pg_total_relation_size` per table and `SELECT avg(pg_column_size(transcript)) FROM agent_scans`.
- **Whether a production dump has ever been drilled.** `db-restore.sh` refuses `prod` as a target;
  whether `--target compose --drill <prod dump>` accepts a file from the `prod` directory was not
  run. Check: run it once with the newest `~/Backups/traders/prod/*.dump` and record the result.
- **`erase_account` covers every table added after 0076** (0077-0086: `legal_acceptances`,
  `agent_suggestions`, research and assistant proposals). The function lists the NO ACTION tables by
  hand. Check: `SELECT conrelid::regclass, confdeltype FROM pg_constraint WHERE confrelid =
  'users'::regclass` and compare the `a` (no action) rows with the function body; confirm
  `m9Exit.postgres.test.ts` seeds a row in each.
- **Connection headroom.** 10 (orchestrator) + 15 (AI service) + one-shot jobs against the default
  `max_connections = 100` looks comfortable; the monthly-cap read then spend
  (`app/llm/monthly_cap.py:115-124`) is not serialised and can overshoot under concurrent calls.
  Check: `SELECT count(*), state FROM pg_stat_activity GROUP BY state` during a scan window.
- **Old containers against the new schema during a deploy.** `up -d` runs `migrate` before
  recreating services, so the previous images serve traffic on the new schema for the build's
  duration. Whether any of 0077-0086 was incompatible with the prior image was not traced; D101's
  expand-then-contract is the rule that prevents it and is not checked by CI.
