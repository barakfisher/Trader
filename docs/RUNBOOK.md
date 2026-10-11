# Runbook

What to do when something needs doing to a running Traders, on either of the two ways it runs:
the **compose stack** (`scripts/dev-docker.sh`, settings in `.env`) and the **kind cluster**
(`scripts/k8s-up.sh`, settings in `infra/k8s/base/config.env` and the git-ignored
`infra/k8s/overlays/kind/secrets.env`). Each procedure says what it changes, how to do it on
each, and how to check it worked.

Shorthands used below:

```bash
# compose: a SQL prompt on the database
docker exec -it traders-postgres-1 psql -U traders -d traders
# cluster: the same
kubectl --context kind-traders -n traders exec -it postgres-0 -- psql -U traders -d traders
```

---

## 1. Rotate a key or secret

Settings are read once, when a process starts, so every rotation is "change the value, then
restart what reads it". On the cluster, `k8s-up.sh` does the restart for you: the Secret's name
carries a hash of its contents, so a changed value produces a new name and every pod that reads it
is replaced.

| Secret | Read by | What rotating it does |
|---|---|---|
| `APP_PASSPHRASE` | orchestrator | the sign-in passphrase changes; existing sessions stay valid |
| `SESSION_SECRET` | orchestrator | **every session ends** - everyone signs in again |
| `INTERNAL_API_KEY` | orchestrator, AI service, CronJobs | service-to-service calls; all readers must change together, or runs and quotes fail with 401 |
| `TELEGRAM_SIGNING_SECRET` | orchestrator | **buttons in already-sent Telegram messages stop working**, and unused bind links die; new messages work. Must differ from the webhook secret (decision 20) |
| `TELEGRAM_WEBHOOK_SECRET` | orchestrator | webhook mode only: Telegram must be told the new value (`setWebhook`), or it is refused |
| `TELEGRAM_BOT_TOKEN` | orchestrator | revoke the old one in @BotFather first if it leaked; the bot then answers only to the new one |
| provider keys (`OPENROUTER_API_KEY`, ...) | AI service | the next call uses the new key; nothing else changes |
| `POSTGRES_PASSWORD` | Postgres, both services | **see below - editing the file alone locks the services out** |

**Compose:** edit `.env`, then `bash scripts/dev-docker.sh`. Compose recreates the containers
whose environment changed.

**Cluster:** edit `infra/k8s/overlays/kind/secrets.env` (non-secret settings: `base/config.env`),
then `bash scripts/k8s-up.sh`. The cluster has no Telegram and no provider keys by design (it is
keyless); add a key to `secrets.env` and its setting to `config.env` if you want one.

**Check:** `curl -s http://127.0.0.1:8080/readyz` (compose) or
`curl -s http://traders.localhost/api/readyz` (cluster) reports `"postgres":"ok","aiService":"ok"`;
a run triggered as in section 2 answers instead of 401.

### The database passwords

There are two roles (migration 0033). **`traders`**, the owner, runs migrations only; **`traders_app`**
is what every service connects as, and can read and write rows and nothing more.

**The app role's password** (`APP_DB_PASSWORD`) is set by the migrate step on every start, so
changing it is: put the new value in `APP_DB_PASSWORD` and in `DATABASE_URL`
(`postgresql://traders_app:<new password>@postgres:5432/traders`) - in `.env` for compose, in
`secrets.env` for the cluster - and restart as above. Migrate runs first and sets it.

**The owner's password** is different: Postgres reads `POSTGRES_PASSWORD` only when it first
creates its data directory. After that, the password lives in the database. So change it in the
database first, then everywhere else:

```sql
ALTER ROLE traders WITH PASSWORD '<new password>';
```

then put the same value in `POSTGRES_PASSWORD` - and, for the cluster, in `MIGRATION_DATABASE_URL`
(`postgresql://traders:<new password>@postgres:5432/traders`) - and restart. Use passwords without
URL-special characters (`openssl rand -hex 16` is safe).

If `secrets.env` is ever lost while the cluster's database still exists, `k8s-up.sh` recovers it
from the Secret the running Postgres reads before it would generate anything, and refuses outright
when a database exists with no Secret to recover from. By hand, the same thing is (every value is
in the Secret):

```bash
# the Secret the running orchestrator reads (older hashed copies may linger beside it)
NAME=$(kubectl --context kind-traders -n traders get deploy orchestrator \
  -o jsonpath='{.spec.template.spec.containers[0].envFrom[1].secretRef.name}')
kubectl --context kind-traders -n traders get secret "$NAME" -o json \
  | python3 -c 'import json,sys,base64; [print(f"{k}={base64.b64decode(v).decode()}") for k,v in json.load(sys.stdin)["data"].items()]' \
  > infra/k8s/overlays/kind/secrets.env
```

---

## 2. Replay a run

Every scheduled run enters through one endpoint, `POST /internal/runs`, with a run key. By default
the key names the run's *bucket* - a day in the user's timezone, or a 15/30-minute window - and a
second trigger in the same bucket is answered `skipped`. That is what makes runs idempotent; it is
also why "just trigger it again" does nothing. To run something again, give it a key of its own.

```bash
# compose (the orchestrator's host port is ORCHESTRATOR_HOST_PORT, default 8080)
KEY=$(grep ^INTERNAL_API_KEY= .env | cut -d= -f2-)
curl -s -X POST http://127.0.0.1:8080/internal/runs \
  -H 'content-type: application/json' -H "x-internal-key: $KEY" \
  -d '{"kind":"portfolio_scan","runKey":"portfolio_scan:manual:'"$(date +%s)"'","trigger":"manual"}'
```

```bash
# cluster: /internal/* is not reachable through the front door, so forward the orchestrator's port
kubectl --context kind-traders -n traders port-forward service/orchestrator 8089:8080 &
KEY=$(grep ^INTERNAL_API_KEY= infra/k8s/overlays/kind/secrets.env | cut -d= -f2-)
curl -s -X POST http://127.0.0.1:8089/internal/runs \
  -H 'content-type: application/json' -H "x-internal-key: $KEY" \
  -d '{"kind":"backfill","runKey":"backfill:manual:'"$(date +%s)"'","trigger":"manual"}'
```

Kinds: `backfill`, `instrument_metadata`, `snapshot`, `news_collect`, `portfolio_scan`,
`topic_scan`, `proposal_sweep`, `topic_discovery`, `daily_digest`, `universe_rescreen`. The answer carries the run's
status and its result. Replaying is safe for every kind: each writes idempotently (observations
and notifications carry a `dedupe_key`; the backfill rewrites only its own rows). The one kind to
think twice about is **`daily_digest`**: a second digest the same day splits the day's deferred
findings across two messages.

**`universe_rescreen`** is different in three ways (decision 90). It belongs to no account, so it
takes no `userId`. It answers 202 once the AI service has it, and the AI service finishes the run
in the background - half an hour or more, as Yahoo rate-limits it; follow it in `runs` or on the
Admin page. And through this endpoint it runs only when **due** - the snapshot last loaded is 91
days old - so a manual trigger usually answers `not due`. To rescreen now, use the Admin page's
**Rescreen universe** button (audited), which is never held back. It rewrites what every topic
resolves against: think twice, as with the digest. A failed rescreen is retried the same day by
any trigger and resumes from its fetch cache. One whose process died (no heartbeat for 5 minutes)
is closed as `failed` by the next claim of any day - the hourly CronJob's or the button's - with
`stats.supersededBy` naming the run that took over, which resumes from the same cache; no row
needs editing by hand.

On the cluster, `kubectl create job --from=cronjob/run-<kind> <name>` triggers the same request as
the schedule - with the default key, so it is `skipped` if the bucket already ran.

**A run stuck in `running`** (its process died mid-run) needs nothing: the next trigger for the same
key takes it over once it is 30 minutes old (`STALE_RUN_MINUTES`, `db/queries/runs.ts`). To see runs:

```sql
SELECT kind, trigger, status, started_at, finished_at, run_key
FROM runs ORDER BY started_at DESC LIMIT 20;
```

`status` is the orchestrator's verdict: `ok`, `degraded` (it ran; something it needed was
missing - the `stats` column says what), `skipped` (nothing to do, with a reason), `failed`.

---

## 3. Recover a stuck proposal

A proposal is a question with a deadline, and its row in `proposals` is the whole of it: the web
and Telegram both answer it through `applyDecision`, and the `proposal_sweep` run records expiries.
(A Mastra workflow used to wait beside it; it was retired in migration 0039.) Start by telling
which state you are looking at:

```sql
SELECT p.id, p.state, p.expires_at, p.decided_at, p.decided_via
FROM proposals p
ORDER BY p.created_at DESC LIMIT 20;
```

| What you see | What it means | What to do |
|---|---|---|
| `pending`, `expires_at` in the past | the sweep has not recorded the expiry yet | nothing: expiry is computed on every read, so it already cannot be approved. If it persists, check the sweep runs (section 2, kind `proposal_sweep`) |
| `pending`, deadline ahead, no Telegram message | it was raised, but the notification did not reach the chat | answer it in the app (**Proposals**); check `SELECT * FROM notifications ORDER BY created_at DESC LIMIT 5` for the delivery's status |
| a decision did not "take" | the request failed before the transition was written | decide again: a transition is conditional on the state that was read, so a repeat answers `unchanged` rather than writing twice |

---

## 4. Everyday checks

| Question | Compose | Cluster |
|---|---|---|
| Is it up? | `curl -s http://127.0.0.1:8080/readyz` | `curl -s http://traders.localhost/api/readyz`; `kubectl --context kind-traders -n traders get pods` |
| Did the scheduled runs happen? | `runs` table (section 2) | the same, plus `kubectl ... get cronjobs` (LAST SCHEDULE) and `get jobs -l app=run-trigger` |
| Why did a run fail? | `docker logs traders-orchestrator-1` | `kubectl ... logs job/<job>` (the orchestrator's answer), `kubectl ... logs deploy/orchestrator` |
| Are prices real and fresh? | the dashboard's price age, per holding | the same, at http://traders.localhost |
| Is the corpus in step with the files? | `cd services/ai && .venv/bin/python scripts/ingest_corpus.py --dry-run` | `kubectl ... logs job/corpus` after a deploy |
| Does the exchange calendar cover the next 90 days? | `cd services/ai && .venv/bin/python scripts/generate_exchange_calendar.py --check`; the test `test_calendar_covers_the_next_90_days` fails first | the same file is in the image |

**Extending the exchange calendar** (once a year, when that test fails): `cd services/ai &&
PYTHONPATH=. .venv/bin/python scripts/generate_exchange_calendar.py --last-year <year + 1>`, compare
the new year's dates with [NYSE's published list](https://www.nyse.com/markets/hours-calendars),
commit the diff. A closure no rule predicts (a national day of mourning) is added to
`data/calendar/xnys.json` by hand with `"source": "manual"`; regeneration keeps it.

---

## 5. Back up and restore the database

Both databases are dumped to this Mac, never into the cluster: kind keeps its volumes inside its
node container, so a dump stored there would be deleted with the database (decision 137). Dumps go
to `~/Backups/traders/<kind|compose>/` (override with `TRADERS_BACKUP_DIR`), readable only by you,
each with a `.counts` file: the rows every table holds in the dump, read back from the archive
before the dump is given its final name. The newest 14 are kept, plus one a week for 8 weeks.

| To | Run |
|---|---|
| back up now | `bash scripts/db-backup.sh --target kind` (or `compose`, or `all` for whichever is running) |
| schedule a daily backup (04:00) | `bash scripts/backup-schedule.sh install`, **from the main checkout**, then `... run` once to check it |
| check the schedule | `bash scripts/backup-schedule.sh status` - loaded, last exit code, age of the newest dumps, the log's tail |
| prove a dump restores | `bash scripts/db-restore.sh --target kind --drill latest` - into a scratch database, compared table by table, then dropped; touches nothing live |
| replace the live database with a dump | `bash scripts/db-restore.sh --target compose <file.dump>` (asks first; `--yes` for scripts) |

**What a real restore does**, so it can be trusted: it restores into `traders_restore` beside the
live database and checks every table against the dump's `.counts` - if that fails, it stops and the
live database is untouched. Only then does it stop the orchestrator and the AI service, rename the
live database to `traders_before_<stamp>`, rename the restored one into its place, and start them
again. Nothing is dropped: the script prints the `DROP DATABASE` for the old one, to run when you
are sure. A dump keeps the schema revision it was taken at; if the code is newer, start the stack
again (`k8s-up.sh` / `dev-docker.sh`) and the migrations bring it forward.

**The two commands that delete a database back it up first:** `scripts/k8s-down.sh` (skip with
`--no-backup`) and `scripts/dev-docker.sh --reset`. If that backup fails, nothing is deleted. Both
start scripts warn when the newest dump is more than 48 hours old - the sign that the schedule has
stopped (the Mac was off all day, or Docker was not running when the job ran).

**Restoring into a new cluster** (after `k8s-down.sh`): `bash scripts/k8s-up.sh` first - its
migrations create the application role a dump's grants name - then
`bash scripts/db-restore.sh --target kind latest`.

More on the cluster: [infra/k8s/README.md](../infra/k8s/README.md).
