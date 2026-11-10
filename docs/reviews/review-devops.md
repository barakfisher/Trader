# Review — DevOps / operations (2026-11-10)

Scope: `infra/`, `scripts/`, `.github/workflows/ci.yml`, `docs/RUNBOOK.md`, `VERSION`. Read-only:
nothing was run against production, no `.env` file was opened, no network was used. Application
security is another reviewer's; where a finding touches it, it is only named.

## How production runs today (as read from the repository)

**Determined from files**

- **Host:** one Oracle Cloud VM (`VM.Standard.A1.Flex`, 2 OCPU / 12 GB, Ubuntu 24.04 aarch64,
  50 GB boot volume), pay-as-you-go account with a $1 budget alert (`docs/RUNBOOK.md:282-294`,
  D347).
- **Orchestration:** Docker Compose, project `traders-prod`
  (`infra/compose/docker-compose.prod.yml:27`). Not Kubernetes: the local kind cluster was deleted
  2026-10-31, `infra/k8s/` and CI's kind job were kept (`.claude/MEMORY.md:307-309`).
- **How code gets there:** `scripts/prod-deploy.sh`, run from the Mac over SSH. The server fetches
  git, checks out the commit detached, and `docker compose up -d --build` builds the images **on
  the server**; there is no registry (`scripts/prod-deploy.sh:9-18,60-77`). Only commits on
  `origin/main` deploy unless `--force` (`:64-67`).
- **TLS:** Caddy 2.10.2 is the only container with published ports (80, 443, 443/udp), gets and
  renews a Let's Encrypt certificate itself, and forwards to nginx (`web`), which serves the bundle
  and proxies `/api/*` to the orchestrator (`docker-compose.prod.yml:188-203`,
  `infra/caddy/Caddyfile:22-25`).
- **Database:** Postgres 16 + pgvector in a container on the same VM, data in the named Docker
  volume `postgres-data` on the boot volume (`docker-compose.prod.yml:45-65,205-206`). Redis the
  same way (`:72-80`).
- **Migrations:** a one-shot `migrate` container (Alembic, as the owner role) that the AI service
  and the orchestrator wait for (`docker-compose.prod.yml:88-102,148-152,163-167`).
- **Scheduled work:** an in-process timer inside the orchestrator container
  (`apps/orchestrator/src/scheduler.ts:1-10`), not cron and not CronJobs.
- **Secrets:** `.env` and `.env.owner` exist only in the server's checkout, mode 600, generated
  there by `scripts/prod-env.sh` and hand-edited with `nano` for provider keys
  (`scripts/prod-env.sh:9-17,105`, `docs/RUNBOOK.md:338-346`).
- **Backups:** a launchd agent on the owner's Mac runs `db-backup.sh --target all` daily at 04:00
  local; for `prod` it pipes `pg_dump` over SSH into `~/Backups/traders/prod/`, reads the archive
  back, and prunes (`infra/launchd/com.traders.db-backup.plist:17-32`, `scripts/db-backup.sh:96-125`,
  `scripts/lib/db-targets.sh:102-109`). No off-site copy: Object Storage is "the next PR" (D348,
  `docs/RUNBOOK.md:315-316`).

**Observed on this Mac (read-only commands, 2026-11-10)**

- `launchctl list` shows `com.traders.db-backup` loaded, last exit code 0.
- `~/Backups/traders/prod/` holds 14 dumps, 2026-11-04 to 2026-11-10 (newest ~46 MB); the log's
  last nightly entry is a successful prod dump of 51 tables.
- No Traders container is running locally; `uname -m` is `arm64`, the same architecture as the
  server.

**Could not determine** (no SSH, no network): what is actually running on the VM, its disk usage,
whether Ubuntu's automatic security updates are on, whether OCI boot-volume backups exist, branch
protection on `main`, CI run times, and whether any uptime monitor exists outside the repository.
See "Unverified".

## Summary (5 lines max)

The delivery path is careful and unusually well tested for a one-person project: CI restores a real
backup, round-trips every migration and checks the production compose file. The weak side is
everything that happens **after** a deploy: nothing watches production, the only backup copy lives
on a laptop and fails silently, and recovery onto a new VM depends on secrets that exist in one
place. Most fixes are small scripts or free services, not new infrastructure.

## What is strong and should stay

- **A backup is not trusted until it is read back** (`scripts/db-backup.sh:109-118`), and CI runs
  a drill and a real restore on every PR (`.github/workflows/ci.yml:214-246`). Most teams never
  test a restore.
- **Migrations are tested over data, both directions, against real Postgres**
  (`ci.yml:66-125`), and no migration leaves Alembic's single transaction (no `CONCURRENTLY` /
  `autocommit_block` in `services/ai/alembic/versions/`), so a migration that fails halfway rolls
  back whole rather than leaving a half-changed schema.
- **`check-prod-compose.sh` in CI** holds the production file to "only Caddy is public, production
  settings, no fixtures, logs capped" (`scripts/check-prod-compose.sh:51-80`).
- **Deploys are by commit, restricted to `main`, and checked from outside** (headers, the refused
  write, `/api/internal/*`) (`scripts/prod-deploy.sh:64-67,97-116`).
- **Startup ordering is enforced, not hoped for**: `service_healthy` /
  `service_completed_successfully` on every dependency that matters
  (`docker-compose.prod.yml:99-101,148-152,163-167`).
- **Secrets are generated on the server and never printed**, with the DB owner's password kept
  away from the app containers (`scripts/prod-env.sh:13-17,100-105`, D300).
- **Non-root app containers** (`infra/docker/Dockerfile.ai:52-54`,
  `Dockerfile.orchestrator:27-28`), dependency layers before source for caching
  (`Dockerfile.ai:18-21`, `Dockerfile.orchestrator:16-20`), secrets excluded from the build context
  (`.dockerignore:9-11,19`).
- **The scheduler asks more often than it runs** and lets the run key collapse repeats
  (`apps/orchestrator/src/scheduler.ts:16-24`), so a restart cannot silently skip a day.
- **D347's choice of compose over k3s/GHCR** is right for one VM and a handful of users. I would
  not add Kubernetes or a registry now.

## Findings (ranked)

### 1. Nothing watches production — High, effort S

- **Evidence:** the only readiness check is run by a human at deploy time
  (`scripts/prod-deploy.sh:97-98`); RUNBOOK's "Did the scheduled runs happen?" is a manual SQL
  query (`docs/RUNBOOK.md:184`); scheduling is a timer inside one process
  (`apps/orchestrator/src/scheduler.ts:1-10`); a repository-wide search for Sentry, healthchecks,
  UptimeRobot, Prometheus or `/metrics` finds only kind's metrics-server. The $1 OCI budget alert
  (`RUNBOOK.md:294`) and the in-code LLM ceiling are the only automatic alarms.
- **Failure it causes:** the site is down, the certificate failed to renew, the disk is full, or
  the scheduler stopped after an unhandled error, and the owner finds out from a user or from an
  empty digest days later. A stopped scheduler looks exactly like a quiet market.
- **Improvement:** two free pieces, no new servers. (a) An external uptime check on
  `https://app.tiklens.com/api/readyz` (it already returns 503 when Postgres is gone,
  `apps/orchestrator/src/http/routes/health.ts:57-60`) that emails/Telegrams on failure. (b) A
  "dead man's switch": a monitor that expects a ping every N minutes and alerts when the ping
  **stops**. Ping it from the scheduler after each successful `snapshot` run and from the backup
  job. First principle: a process cannot report its own death, so something outside must notice
  the silence. Ask before choosing the service (healthchecks.io, UptimeRobot, Better Stack free
  tiers all do this); extend `/readyz` with "minutes since the last successful run" and "disk
  free" so one URL covers both.

### 2. The only backup copy is on a laptop, and a failed production backup is silent — High, effort M

- **Evidence:** dumps go to the Mac only (`docs/RUNBOOK.md:313-316`, D348; D147 chose no
  off-laptop copy when the data was simulated). With `--target all`, an unreachable production
  host is a warning and exit 0 (`scripts/db-backup.sh:137-145`: `db_target_available prod` false
  -> "skipped"). The only staleness alarm prints when the owner happens to start the **dev**
  stack (`scripts/dev-docker.sh:109`, `scripts/lib/backups.sh:78-92`); `prod-deploy.sh` never
  calls it. This already happened once: every nightly production backup failed until 2026-11-03
  (`scripts/check-db-targets.sh:11-13`). Dumps are unencrypted files (`db-backup.sh:100,127`).
- **Failure it causes:** the Mac is off, travelling, or its SSH key is not unlocked for a week;
  launchd reports exit 0; the VM's disk dies; the newest restorable state is a week old. Or the
  Mac is lost and the only copy (with every user's holdings and email) goes with it.
- **Improvement:** I agree with D348's staging and would do its second half now, since
  production holds other people's data, which is D147's own revisit condition in spirit. Run the
  dump **on the server** on a systemd timer (Linux's launchd), encrypt it (`age` or `gpg`, public
  key on the server, private key only with the owner), and upload to an OCI Object Storage bucket
  with a lifecycle rule for retention. First principle: a backup must survive the loss of the
  machine it protects **and** must not depend on a second machine being awake. Keep the Mac pull
  as a second copy. Make `--target all` exit non-zero when a *configured* target is unreachable,
  and ping the dead man's switch from finding 1 on success. This also moves RPO from "24 h if the
  laptop was open" to a known 24 h (or less, the dump is 46 MB).

### 3. Losing the VM loses secrets that the database backup depends on; rebuilding the host is unrehearsed — High, effort S (secrets) / M (drill)

- **Evidence:** production's `.env` exists nowhere but the server, by rule
  (`.claude/MEMORY.md:333-334`); `LLM_KEY_ENCRYPTION_KEYS` is generated there
  (`scripts/prod-env.sh:90`) and encrypts users' saved OpenRouter keys (`docs/RUNBOOK.md:36`).
  `db-restore.sh` refuses `prod`; a production restore is two sentences of prose
  (`docs/RUNBOOK.md:316-318`). A new host is eight manual steps plus a file copy
  (`RUNBOOK.md:320-361`).
- **Failure it causes:** the VM is terminated or its volume corrupts. The dump restores, but
  every saved user key is undecryptable, the Telegram signing secret is new so buttons in sent
  messages die, and the owner performs an eight-step procedure for the first time during an
  outage. RTO is unknown because it has never been measured.
- **Improvement:** (a) keep one encrypted copy of the server's `.env` and `.env.owner` off the
  server, e.g. in the owner's password manager, updated when a key rotates. First principle: an
  encrypted backup is only as recoverable as its key. This does not contradict "never copy it to
  a chat"; it changes "one copy" to "two copies, both private". (b) Once, time a full rebuild
  on a second (free-tier) VM from the newest dump, write the measured RTO into the RUNBOOK, and
  turn the prose restore into a script that refuses to run without a fresh pre-restore dump. The
  2026-11-09 rehearsal of migrations on a restored production copy (`.claude/MEMORY.md:9-10`) is
  good evidence the *dump* is sound; the *host* rebuild is the untested half.

### 4. A deploy across a migration has no way back, and the script takes no backup first — Med, effort S

- **Evidence:** known debt (D347; `docs/RUNBOOK.md:307-309`). `prod-deploy.sh` goes from checkout
  straight to `up -d --build` (`scripts/prod-deploy.sh:68-77`). The safe practice (back up, try
  compose first, rehearse on a restored copy) lives in memory files and habit, not in the script.
- **Failure it causes:** a migration succeeds, the new code then fails on real data, and the old
  commit cannot run on the new schema. The newest dump is from 04:00; everything users did since
  is lost in the restore.
- **Improvement:** have the deploy script compare Alembic's current revision with the target
  commit's head and, when they differ, take a `pg_dump` on the server first and print its name.
  First principle: the cheapest rollback for a schema change is a snapshot taken seconds before
  it. Longer term, the "expand, then contract" habit (add columns in one release, remove old ones
  in a later one) makes the previous commit runnable on the new schema, so going back is just
  `prod-deploy.sh <commit>` again. I agree with not running Alembic downgrades in production.

### 5. Every deploy deletes the previous version's logs — Med, effort S

- **Evidence:** logs use Docker's `json-file` driver, 3 x 10 MB per container
  (`docker-compose.prod.yml:29-34`). Those files belong to the container, and a deploy replaces
  each container whose image changed (`prod-deploy.sh:77`). Build output goes to one overwritten
  file (`/tmp/traders-deploy.log`, `:77`). RUNBOOK's "why did a run fail" is `docker logs`
  (`RUNBOOK.md:185`).
- **Failure it causes:** a bug shows up an hour after a deploy; the logs from before the deploy,
  the ones needed to tell "new bug" from "old bug", no longer exist. Slow-query logging
  (`docker-compose.prod.yml:51-58`) is lost the same way.
- **Improvement:** switch the driver to `journald` (the host's system log keeps entries after a
  container is gone, with its own size cap, e.g. `SystemMaxUse=1G`), or ship logs to a hosted
  free tier. First principle: logs must outlive the thing they describe. The cap check in
  `check-prod-compose.sh:56` would need the matching change.

### 6. Images are built on the production host and nothing ever cleans up — Med, effort S

- **Evidence:** `up -d --build` on the server (`prod-deploy.sh:77`), four services building from
  `Dockerfile.ai` plus two Node images, on a 50 GB volume that also holds Postgres
  (`RUNBOOK.md:289`). No `docker image prune` / `builder prune` anywhere in `scripts/` or the
  RUNBOOK. No memory or CPU limits in the compose file (`docker-compose.prod.yml`, none present).
- **Failure it causes:** each deploy leaves the previous images and build cache behind; after
  enough deploys the disk fills, Postgres cannot write, and the app goes down with no alert
  (finding 1). Separately, a build competes with the live database for 2 CPUs.
- **Improvement:** after a successful deploy, prune images and build cache older than a few days
  (keep the last one for a fast way back) and print `df -h /` at the end of every deploy. Add
  `mem_limit` to `ai-service` and `orchestrator` so a runaway process is killed before the kernel
  picks Postgres. First principle: a disk shared by "things that grow" and "the database" needs a
  ceiling on the first. I agree with D347's rejection of a registry for now.

### 7. Python dependencies are resolved at build time, unlocked — Med, effort S

- **Evidence:** known debt (D347). `services/ai/pyproject.toml:6-32` uses `>=` floors only and no
  lock file exists; `infra/docker/Dockerfile.ai:21` runs `pip install .` on the server at deploy
  time; CI resolves separately (`ci.yml:23`). Node is locked (`--frozen-lockfile`,
  `Dockerfile.orchestrator:20`).
- **Failure it causes:** the image deployed is not the dependency set CI tested. Worst case is
  the rollback: redeploying last month's commit installs **today's** `openai`, `yfinance` and
  `langfuse`, so "the way back" (`prod-deploy.sh:6`) is a new, untested build.
- **Improvement:** commit a `uv.lock` (CI already uses `uv`, `ci.yml:21`) and install from it in
  both CI and the Dockerfile. First principle: a lock file records the exact versions that passed
  the tests, so every later build reproduces them. This is a tooling change, not a new package;
  raise it as its own decision since D347 lists it as debt.

### 8. CI trusts moving references and has no dependency or image checks — Med, effort S

- **Evidence:** actions pinned by major tag (`ci.yml:20,21,48,49,97,98,106,107`); the kind binary
  is downloaded and installed with no checksum (`ci.yml:276-277`); `.github/` contains only
  `workflows/` (no Dependabot or Renovate config); no `pnpm audit`, `pip-audit`, Trivy or
  shellcheck step, though ~2,000 lines of bash carry deploys and backups and already hold
  `# shellcheck` directives (`scripts/prod-deploy.sh:25`). Only the kind job has
  `timeout-minutes` (`ci.yml:268`).
- **Failure it causes:** a compromised or retagged action runs with the repository's token; a
  known-vulnerable dependency or base image ships because nothing looks; a quoting bug in a
  deploy script is found in production.
- **Improvement:** pin third-party actions to commit SHAs and let Dependabot propose updates
  (it also covers pnpm, pip and Docker base images weekly); add `shellcheck scripts/**/*.sh` and
  a non-blocking audit job first, blocking once quiet; add a timeout to every job. First
  principle: a tag is a name someone else can move; a SHA is the content itself.

### 9. Base images float and are never refreshed on the server — Low/Med, effort S

- **Evidence:** known debt for digests (D347). `python:3.12-slim` (`Dockerfile.ai:4`),
  `node:22-slim` (`Dockerfile.orchestrator:3`, `Dockerfile.web:5`), `nginx:1.27-alpine`
  (`Dockerfile.web:44`), `pgvector/pgvector:pg16` and `redis:7-alpine`
  (`docker-compose.prod.yml:46,73`). The deploy builds without `--pull` (`prod-deploy.sh:77`).
- **Failure it causes:** two opposite problems. The server keeps whatever it pulled on day one,
  so OS security fixes in base images never arrive; a rebuilt host pulls whatever the tags mean
  that day, possibly a different Postgres minor than the one the data was written by.
- **Improvement:** pin by digest and let Dependabot (finding 8) raise the bump as a PR that CI
  tests. First principle: updates should arrive as reviewed changes, neither never nor by
  surprise.

### 10. The RUNBOOK's operating procedures do not cover production — Med, effort S

- **Evidence:** the opening names two ways it runs, compose and kind (`docs/RUNBOOK.md:3-7`).
  Rotating a secret is described for dev compose and the cluster only (`:39-45`); replaying a run
  curls `127.0.0.1:8080` (`:107-111`), a port production does not publish
  (`docker-compose.prod.yml:13-14`); "Everyday checks" has Compose and Cluster columns and no
  production one (`:181-189`); section 5 still says "Both databases" and `<kind|compose>`
  (`:201-203`); section 7 says the host "is chosen at deployment" (`:255-256`).
- **Failure it causes:** during an incident on the real system the owner follows the kind column
  (a cluster that no longer exists) or improvises over SSH. Rotating `SESSION_SECRET` or a leaked
  OpenRouter key in production has no written steps.
- **Improvement:** add a Production column to sections 1, 2 and 4 (edit `.env` on the server,
  then `prod-deploy.sh`; `docker compose exec orchestrator curl ...` for a manual run; logs and
  `df -h`), and mark the kind columns as "CI only since 2026-10-31".

### 11. The kept Kubernetes path costs more than it returns — Low, effort S to decide

- **Evidence:** kept on purpose (`.claude/MEMORY.md:308-309`). A 30-minute-budget CI job on every
  PR (`ci.yml:265-345`), `scripts/k8s-up.sh` (334 lines), `infra/k8s/base/cronjobs.yaml` that must
  mirror `scheduler.ts` (`apps/orchestrator/src/scheduler.ts:25-26`). Residue outside CI: the
  backup schedule requires `kubectl` to install (`scripts/backup-schedule.sh:42`) and the nightly
  log warns "the kind database is not running - skipped" every night (`db-backup.sh:142`), which
  trains the eye to ignore warnings in the one log that matters.
- **Failure it causes:** no outage; steady cost. Every infra change is made twice, and the copy
  nothing runs on is the one that drifts or blocks a PR.
- **Improvement:** decide explicitly. If Kubernetes is a learning goal or a likely next host,
  keep it and say so in the RUNBOOK. Otherwise run the kind job only when `infra/k8s/**` or
  `scripts/k8s-*` changes (a `paths:` filter), and drop `kind` from `db_targets` when no cluster
  context exists. I would not delete the manifests; I would stop paying for them on every PR.

### 12. Production's architecture is never built in CI — Low, effort S

- **Evidence:** all jobs run on `ubuntu-latest` (amd64) (`ci.yml:15,41,81,129,267`); the server is
  aarch64 (`RUNBOOK.md:289`); `Dockerfile.ai:12-13` installs no compiler because "every dependency
  ships wheels for this platform".
- **Failure it causes:** a dependency release without an arm64 wheel builds in CI and fails on
  the server, in the middle of a deploy. Today the owner's arm64 Mac catches this through the
  compose-first habit; nothing enforces it.
- **Improvement:** build the three images in one job on a GitHub arm64 runner
  (`ubuntu-24.04-arm`; free for public repositories, billed minutes for private ones). A lock file (finding 7) removes most of the risk by itself.

### 13. Retention counts dumps, not days — Low, effort S

- **Evidence:** "newest 14" is by count (`scripts/lib/backups.sh:25-28`,
  `scripts/db-backup.sh:72-75`), and manual pre-deploy dumps count too: the 14 production dumps
  on this Mac span six days (2026-11-04 to 2026-11-10).
- **Failure it causes:** on a busy deploy day the "two weeks of dailies" shrink to a few days; a
  slow data corruption noticed after a week has only the weekly dumps to fall back on.
- **Improvement:** keep the newest dump of each of the last 14 **days** plus every dump from the
  last 48 hours. The CI retention test (`ci.yml:224-239`) would change with it.

### 14. Three version numbers, and none answers "what is running?" from outside — Low, effort S

- **Evidence:** `VERSION` is `0.0.3`; `/readyz` reports a hard-coded `0.1.0`
  (`apps/orchestrator/src/http/routes/health.ts:13`); `services/ai/pyproject.toml:3` says `0.1.0`;
  the commit is known only to the web bundle (`infra/docker/Dockerfile.web:25-26`). The deploy
  script checks that the site answers, not that it is the commit it just deployed
  (`prod-deploy.sh:97-98`).
- **Failure it causes:** a deploy whose containers were not replaced still passes its checks; an
  uptime monitor cannot tell which release is misbehaving.
- **Improvement:** pass the commit to the orchestrator as an environment variable, return it
  from `/readyz`, and have `prod-deploy.sh` wait until that value equals the commit it deployed.

### 15. Production images carry build and test tooling — Low, effort M

- **Evidence:** `Dockerfile.ai:21,27` installs pytest and ruff and copies `tests/`;
  `Dockerfile.orchestrator:20` installs dev dependencies and runs TypeScript through `tsx`
  (a recorded choice, `:34-37`); both are single-stage; nginx runs with the image's default root
  master process (`Dockerfile.web:44-48`).
- **Failure it causes:** larger images (slower builds on the 2-CPU host, more disk for
  finding 6) and more installed code than runs.
- **Improvement:** a second build stage that copies only the installed runtime packages, when
  someone is already in these files. Not worth a PR of its own at this size.

**Accepted as they are (no finding):** about a minute of 502s while containers are replaced
during a deploy; deploying from the laptop rather than from CI (a deploy key in GitHub would be
a bigger risk than the Mac at this scale); no separate staging host (compose on an arm64 Mac plus
the restored-copy rehearsal is a reasonable stand-in for a few users).

## Unverified

| Question | The check that settles it |
|---|---|
| Is anything outside the repository already monitoring the site? | Ask the owner; otherwise finding 1 stands. |
| How full is the server's disk, and how much is Docker's? | `ssh traders-prod 'df -h / && docker system df'` |
| Are Ubuntu security updates automatic on the VM? | `ssh traders-prod 'systemctl is-enabled unattended-upgrades; cat /etc/apt/apt.conf.d/20auto-upgrades'` |
| Does OCI back up the boot volume (which holds Postgres)? | OCI console: Block Storage -> Boot Volumes -> Backup Policies. |
| Is the Mac's disk encrypted, and does Time Machine or iCloud copy `~/Backups`? | `fdesetup status`; `tmutil destinationinfo`. Dumps are plaintext, mode 600. |
| Does the nightly job reach production when the Mac was asleep at 04:00 and the SSH key is locked? | After a night with the lid closed: `bash scripts/backup-schedule.sh status` and the dump's timestamp. The log shows successes; it cannot show skipped nights. |
| Has a production dump ever been restored **on a server**, and how long does a rebuild take? | The drill in finding 3. |
| Does the production OpenRouter key have a provider-side spending limit? | OpenRouter dashboard -> Keys (the handoff asks for one, `.claude/MEMORY.md:8216`). |
| Is `main` protected (required checks, no direct pushes)? | `gh api repos/barakfisher/Trader/branches/main/protection` |
| How long does CI take, and how much of it is the kind job? | `gh run list --workflow CI --limit 20 --json databaseId,conclusion,createdAt,updatedAt` then `gh run view <id>` per job. |
| Do Postgres and pgvector on the server match the Mac's `pg16` image? | `ssh traders-prod 'docker exec $(docker ps -qf label=com.docker.compose.service=postgres) psql -U traders -d traders -Atc "select version(); select extversion from pg_extension where extname = $$vector$$"'` |
| Does the orchestrator get SIGTERM through `pnpm start` and finish in Docker's 10 s grace period? | `docker compose stop orchestrator` on compose and read the log for the shutdown line (`apps/orchestrator/src/server.ts:89`) and the stop time. |
| Does a deploy in the middle of a paid scan waste the model call? | Read `runs` / `llm_calls` around a deploy's timestamp. |
