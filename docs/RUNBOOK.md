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
| the admin's password | the database, not a setting | `bash scripts/admin-password.sh <compose\|kind\|local> <email>` - a new password, printed once; **every session the admin holds ends** (D179) |
| `SESSION_SECRET` | orchestrator | **every session ends** - everyone signs in again |
| `INTERNAL_API_KEY` | orchestrator, AI service, CronJobs | service-to-service calls; all readers must change together, or runs and quotes fail with 401 |
| `TELEGRAM_SIGNING_SECRET` | orchestrator | **buttons in already-sent Telegram messages stop working**, and unused bind links die; new messages work. Must differ from the webhook secret (decision 20) |
| `TELEGRAM_WEBHOOK_SECRET` | orchestrator | webhook mode only: Telegram must be told the new value (`setWebhook`), or it is refused |
| `TELEGRAM_BOT_TOKEN` | orchestrator | revoke the old one in @BotFather first if it leaked; the bot then answers only to the new one |
| provider keys (`OPENROUTER_API_KEY`, ...) | AI service | the next call uses the new key; nothing else changes |
| `LLM_KEY_ENCRYPTION_KEYS` | AI service | encrypts users' own OpenRouter keys (D208). **Put the new key first and keep the old one after it**, restart, run `cd services/ai && .venv/bin/python scripts/reencrypt_llm_keys.py` (in a container: `python scripts/reencrypt_llm_keys.py`), then drop the old key and restart. Dropping it first leaves saved keys unreadable: their owners go back under the cap until they save their key again |
| `POSTGRES_PASSWORD`, `MIGRATION_DATABASE_URL` | Postgres and migrate only - `.env.owner` (compose), `owner.env` (cluster; D300) | **see below - editing the file alone locks migrate out** |

**Compose:** edit `.env` (the owner's password: `.env.owner`), then `bash scripts/dev-docker.sh`.
Compose recreates the containers whose environment changed.

**Cluster:** edit `infra/k8s/overlays/kind/secrets.env` (the owner's password: `owner.env` beside
it; non-secret settings: `base/config.env`),
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

then put the same value in `POSTGRES_PASSWORD` and in `MIGRATION_DATABASE_URL`
(`postgresql://traders:<new password>@postgres:5432/traders`) - in `.env.owner` for compose, in
`owner.env` for the cluster - and restart. Use passwords without URL-special characters
(`openssl rand -hex 16` is safe).

**Why the owner has a file of its own (D300):** compose loads `.env` into every service and every
pod loads `traders-secrets`, so a password kept there reached all of them, though only Postgres and
migrate use it. `.env.owner` and the `traders-owner` Secret are read by those two alone. The start
scripts and `k8s-up.sh` move the lines out of a file written before the split, values unchanged,
and refuse when the two files disagree: delete the stale line once you know which value the
database was created with.

If `secrets.env` or `owner.env` is ever lost while the cluster's database still exists,
`k8s-up.sh` recovers each from the Secret the running cluster reads it from - `secrets.env` from
the orchestrator's, `owner.env` from Postgres's - before it would generate anything, and refuses
outright when a database exists with no Secret to recover from. By hand, the same thing is (for
`owner.env`, the Secret named by the Postgres StatefulSet's `POSTGRES_PASSWORD`, keeping only
`POSTGRES_PASSWORD` and `MIGRATION_DATABASE_URL`):

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

---

## 6. What the database is doing - query statistics

Both Postgres servers start with `pg_stat_statements` preloaded (the flags are in
`infra/compose/docker-compose.yml` and `infra/k8s/base/postgres.yaml`, kept identical) and
migration 0050 creates the extension. Statements slower than 200 ms and lock waits are written to
the server's log. It is how indexes and retention are chosen: from what the services actually run,
not from guesses (decision 141).

| To | Run |
|---|---|
| read the report | `bash scripts/db-report.sh --target kind` (or `compose`) - statements by total time, tables read whole, indexes never scanned, the largest tables, the slow-statement log |
| start a clean measurement window | `bash scripts/db-report.sh --target kind --reset` - zeroes the statement and table/index counters; the only flag that writes |
| read the slow log directly | `kubectl --context kind-traders -n traders logs postgres-0 \| grep duration:` / `docker logs traders-postgres-1 2>&1 \| grep duration:` |

The report runs as the database owner; the application role cannot read the statistics (0050
revokes them). An index the report lists as never scanned is a candidate, not a verdict: only a
window that covered every scheduled run - a full week - says it is unused, and unique indexes are
left out because they enforce a rule whether or not a query reads them.

## 7. Serving it on the internet: the production baseline

Before any public address points at Traders (D256), every item here must hold. The rented host and
its domain are chosen at deployment (D255). Until then, kind and compose stay `development`.

| Setting | Value on the public host | Why |
|---|---|---|
| `APP_ENV` | `production` | The session cookie becomes `Secure`, sent only over HTTPS. TLS ends at the host's edge; never set it where the browser reaches the app over plain HTTP, or nobody stays signed in |
| `ALLOWED_ORIGINS` | `https://<the domain>` only | A write whose Origin is missing or not listed is refused (`missing_origin`, `bad_origin`). The orchestrator refuses to start in production unless the first entry is https: the approval mail links to it (D344, D345) |
| `TRUSTED_PROXY_HOPS` | nginx plus the host's own proxies (2 behind one load balancer) | The client's address is read past exactly these. Too high, and a client chooses its own address with a header |
| The web image | the `prod` target (nginx) | It serves the security headers (`infra/docker/security-headers.conf`) and refuses `/api/internal/*`. Compose's `dev` target is the Vite dev server and is never public |

Check it from outside, against the public address:

```bash
curl -sI https://<the domain>/ | grep -iE "content-security-policy|strict-transport|x-content-type"
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<the domain>/api/auth/logout   # 403: no Origin
```

The same header checks run on every PR against the image (`scripts/check-web-image.sh`). A new
third-party origin in the page - a font, a script - is blocked by the browser until it is named in
the CSP there.

More on the cluster: [infra/k8s/README.md](../infra/k8s/README.md).

---

## 8. The production host

The private-first public installation (M10 PR 16, D255, D347-D350): one Oracle Cloud VM running
`infra/compose/docker-compose.prod.yml`, with Caddy in front for https. The images are built on
the server from git; the Mac only runs commands over SSH.

| | |
|---|---|
| Address | `https://app.tiklens.com` (a temporary domain, Spaceship; DNS: one `A` record `app`) |
| Server | Oracle Cloud `traders-prod`: VM.Standard.A1.Flex, 2 OCPUs, 12 GB (Always Free covers up to 4 / 24), Ubuntu 24.04 aarch64, a 50 GB boot volume |
| SSH | `ssh traders-prod` - the alias in `~/.ssh/config`, user `ubuntu`, key `~/.ssh/traders_oci`. The key's passphrase is in the Passwords app, "traders-oci SSH key"; never in the repository |
| Checkout | `~/traders` on the server, detached at the deployed commit |
| Secrets | `~/traders/.env` and `~/traders/.env.owner` on the server, mode 600, written by `scripts/prod-env.sh` |
| Open ports | 22 (SSH), 80 and 443 in the subnet's security list. That list is what guards a container's published port: Docker forwards it before the server's own iptables (`/etc/iptables/rules.v4`) sees it, so the iptables rules matter only for what listens on the host itself. Only Caddy may publish a port (`scripts/check-prod-compose.sh`, in CI) |
| Spend guard | an OCI budget of $1 with an email alert |

### Deploy, and go back

```bash
bash scripts/prod-deploy.sh            # what is on origin/main
bash scripts/prod-deploy.sh <commit>   # a given commit - also the way back to the previous one
```

It refuses a commit that is not on `origin/main` unless `--force` follows it (a pushed branch
nobody reviewed must not deploy by accident). It fetches, checks the commit out, builds on the
server, starts the stack (migrations first),
then waits for `https://<APP_DOMAIN>` and `/api/readyz` and checks the security headers, the
refused Origin-less write and the unreachable `/api/internal/*` from outside. Going back is
deploying the earlier commit - **except across a migration**: Alembic does not run downgrades
here, so an older commit on a newer schema needs the restore below.

### Back up

`bash scripts/db-backup.sh --target prod` pulls a verified dump over SSH into
`~/Backups/traders/prod/` (D348), and the daily schedule (`backup-schedule.sh`, section 5)
includes `prod` on any Mac whose `~/.ssh/config` knows `traders-prod`. **Off-host only while the
Mac is on**: a copy in OCI Object Storage is the next PR. A restore is deliberately not wired to
`prod` (`db-restore.sh` refuses it): to restore, copy the dump to the server and run
`pg_restore` there, after a fresh backup of what is being replaced.

### First time on a new server

In this order; each step is idempotent or refuses to repeat.

1. **The machine.** The console steps: shape and image as in the table, a public IPv4 address
   (the instance's VNIC, *Ephemeral public IP*), ingress rules for TCP 80 and 443 from
   `0.0.0.0/0` in the subnet's security list, and the public half of `~/.ssh/traders_oci`.
2. **The server's own firewall** (Oracle's Ubuntu image rejects everything but SSH; this
   matters for anything listening on the host itself, not for Docker's published ports):
   ```bash
   ssh traders-prod 'sudo iptables -I INPUT 5 -p tcp -m state --state NEW --dport 80 -j ACCEPT && sudo iptables -I INPUT 6 -p tcp -m state --state NEW --dport 443 -j ACCEPT && sudo netfilter-persistent save'
   ```
3. **Docker**, from Docker's own apt repository (docs.docker.com/engine/install/ubuntu), then
   `sudo usermod -aG docker ubuntu`.
4. **The checkout:**
   ```bash
   ssh traders-prod 'git clone https://github.com/barakfisher/Trader.git ~/traders'
   ```
5. **The secrets**, generated on the server and never printed:
   ```bash
   ssh traders-prod 'cd ~/traders && bash scripts/prod-env.sh app.tiklens.com <admin email>'
   ```
6. **What only you can supply**, typed on the server: `ssh traders-prod`, then
   `nano ~/traders/.env`, and fill `OPENROUTER_API_KEY` (a key of its own, not development's),
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` (a bot of its own: two installations polling
   one bot steal each other's updates), and the mail provider's `SMTP_*` and `EMAIL_FROM`.
   Until mail is set, sign-up answers `closed` (D259).
7. **Deploy:** `bash scripts/prod-deploy.sh`.
8. **The admin's password**, at your own terminal (it is printed once, to you alone):
   ```bash
   ssh -t traders-prod 'cd ~/traders && bash scripts/admin-password.sh prod <admin email>'
   ```
   Keep it in the Passwords app. Then sign in, open Admin → Settings, and set sign-up to
   *approval* (D344): *automatic* stays held until the legal text exists.

### What production deliberately does without (D350)

- **Yahoo's company descriptions** are not loaded: topic resolution answers `unavailable` with
  `universe.state: not_loaded`. Loading them is a copy of `descriptions.local.jsonl` to
  `~/traders/data/universe/` and a mount - decided together with the legal text.
- **Prices come from `yfinance`** and headlines from GDELT and Yahoo, with no fixture fallback:
  an unavailable price is unpriced. Acceptable for the private phase only; decided again before
  sign-up opens to strangers.
