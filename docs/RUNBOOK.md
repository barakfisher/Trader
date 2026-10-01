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
key takes it over once it is 30 minutes old (`STALE_RUN_MINUTES`, `db/queries.ts`). To see runs:

```sql
SELECT kind, trigger, status, started_at, finished_at, run_key
FROM runs ORDER BY started_at DESC LIMIT 20;
```

`status` is the orchestrator's verdict: `ok`, `degraded` (it ran; something it needed was
missing - the `stats` column says what), `skipped` (nothing to do, with a reason), `failed`.

---

## 3. Recover a stuck proposal

A proposal is a question with a deadline; its row in `proposals` is the source of truth, and a
durable workflow (`proposalLifecycle`, Mastra) waits on it. The design makes most "stuck" states
impossible, so start by telling which one you are looking at:

```sql
SELECT p.id, p.state, p.expires_at, p.decided_at, p.decided_via,
       s.snapshot->>'status' AS workflow
FROM proposals p
LEFT JOIN mastra.mastra_workflow_snapshot s
       ON s.workflow_name = 'proposalLifecycle' AND s.run_id = p.observation_id::text
ORDER BY p.created_at DESC LIMIT 20;
```

| What you see | What it means | What to do |
|---|---|---|
| `pending`, `expires_at` in the past | the sweep has not recorded the expiry yet | nothing: expiry is computed on every read, so it already cannot be approved. If it persists, check the sweep runs (section 2, kind `proposal_sweep`) |
| `pending`, deadline ahead, no Telegram message | it was raised, but the notification did not reach the chat | answer it in the app (**Proposals**); check `SELECT * FROM notifications ORDER BY created_at DESC LIMIT 5` for the delivery's status |
| a decision in the app did not "take" | a resume of the workflow failed | nothing: a failed resume falls back to writing the decision directly (`proposalLifecycle.ts`), and deciding again answers `unchanged` rather than writing twice |
| `approved`/`rejected`/`expired`, workflow `suspended` | the decision is recorded; only the waiting workflow was not closed yet | nothing: the next `proposal_sweep` (every 15 minutes) closes it and counts it in `stats.closed`. If one survives several sweeps, see below |

**Closing a leftover workflow.** The sweep closes the workflows of proposals it expires, and -
since independent task 14 - any left `suspended` beside an already-*decided* proposal (what a
failed resume leaves behind), by resuming it with `refresh`. One that survives several sweeps is
failing to resume: the sweep logs `proposal.lifecycle_close_failed` for it. It occupies one row in
`mastra.mastra_workflow_snapshot` and affects nothing else. To remove such rows by hand - a deletion, so take a backup first (`docker exec traders-postgres-1 pg_dump -U traders
traders > backup.sql`) - delete only those whose proposal is terminal:

```sql
DELETE FROM mastra.mastra_workflow_snapshot s
USING proposals p
WHERE s.workflow_name = 'proposalLifecycle'
  AND s.run_id = p.observation_id::text
  AND s.snapshot->>'status' = 'suspended'
  AND p.state IN ('approved', 'rejected', 'expired');
```

Never delete a row whose proposal is still `pending` or `snoozed`: that workflow is the one
waiting for the answer.

---

## 4. Everyday checks

| Question | Compose | Cluster |
|---|---|---|
| Is it up? | `curl -s http://127.0.0.1:8080/readyz` | `curl -s http://traders.localhost/api/readyz`; `kubectl --context kind-traders -n traders get pods` |
| Did the scheduled runs happen? | `runs` table (section 2) | the same, plus `kubectl ... get cronjobs` (LAST SCHEDULE) and `get jobs -l app=run-trigger` |
| Why did a run fail? | `docker logs traders-orchestrator-1` | `kubectl ... logs job/<job>` (the orchestrator's answer), `kubectl ... logs deploy/orchestrator` |
| Are prices real and fresh? | the dashboard's price age, per holding | the same, at http://traders.localhost |
| Is the corpus in step with the files? | `cd services/ai && .venv/bin/python scripts/ingest_corpus.py --dry-run` | `kubectl ... logs job/corpus` after a deploy |

More on the cluster: [infra/k8s/README.md](../infra/k8s/README.md).
