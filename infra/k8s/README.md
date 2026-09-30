# Kubernetes manifests

Milestone 7. Traders on a local [kind](https://kind.sigs.k8s.io) cluster: Kubernetes running
inside one Docker container on your machine, next to (and independent of) the compose stack.

```bash
brew install kind kubectl
bash scripts/k8s-up.sh      # create the cluster if needed, build, load, deploy
bash scripts/k8s-down.sh    # delete the cluster and its database (asks first)
```

Every `kubectl` command below names the context, so it cannot reach another cluster:
`kubectl --context kind-traders -n traders get pods`.

## Layout

```
infra/k8s/
  kind/cluster.yaml          the cluster itself: one node, the universe mount
  base/                      what Traders is, on any cluster
    kustomization.yaml         lists the files; sets the namespace; generates the ConfigMap
    config.env                 non-secret settings (keyless defaults)
    namespace.yaml, postgres.yaml, redis.yaml, jobs.yaml
  overlays/kind/             what only this machine has
    kustomization.yaml         the Secret, from secrets.env (git-ignored, generated)
    universe-descriptions.yaml mounts this machine's licensed descriptions into one Job
  .deploy/                   written by k8s-up.sh per deploy: the image tags (git-ignored)
```

[Kustomize](https://kustomize.io) is built into `kubectl` (`apply -k`). It is plain YAML plus a
small file saying which YAML to use and what to change in it - there is no template language,
so `kubectl kustomize infra/k8s/.deploy` prints exactly what gets applied.

## What runs, and why each object exists

| Object | What it is | Why Traders needs it |
|---|---|---|
| Namespace `traders` | a named folder for objects | nothing collides with other apps; one command lists or removes everything |
| ConfigMap `traders-config-<hash>` | settings injected as environment variables | the non-secret half of `.env`; the hash makes pods restart when a setting changes |
| Secret `traders-secrets-<hash>` | the same, for secrets | passphrase, session key, internal key, DB password - never in git or an image. Base64, not encryption |
| Service `postgres`, `redis` | a fixed name and address in front of changing pods | every connection string names the Service, never a pod |
| StatefulSet `postgres`, `redis` | keeps one pod with a stable identity and its own disk | a database must get the *same* disk back after a restart |
| PersistentVolumeClaim `data-postgres-0` | a request for a disk that outlives any pod | without it, deleting the pod deletes the data |
| Job `migrate`, `corpus`, `universe` | runs a pod to completion, retrying on failure | the compose one-shot containers; re-run on every deploy |
| init container | runs to completion before a pod's main container starts | Kubernetes has no `depends_on`: each pod waits for what it needs itself |

**Ordering without `depends_on`.** Everything starts the moment it is applied. `migrate` waits for
Postgres (`pg_isready`); the loaders wait until the schema is at their image's migration head
(`services/ai/scripts/wait_for_schema.py`), which is also how the services will be guarded - a pod
restarted a week later checks the schema again rather than relying on a Job it never saw. The
loaders failing never stops the app, as in compose.

**Secrets.** `scripts/k8s-up.sh` writes `overlays/kind/secrets.env` on the first run: random
session and internal keys, a random database password, and the sign-in passphrase copied from
your `.env` (so you sign in to both stacks the same way). It is never rewritten, because Postgres
reads the password only when it first creates its data directory - a new password would lock the
services out of the existing database. To start over: `k8s-down.sh`, then delete the file.

**Settings.** `base/config.env` is keyless: Yahoo prices (no key needed), fixture news, fixture
embeddings, template narration, Telegram off. The compose stack keeps its own `.env`; the two
share no database, no Telegram bot and no GDELT downloads.

## Rules the remaining manifests must keep

1. `SCHEDULER_ENABLED=false` on the orchestrator (already in `config.env`). The in-process timer
   and a CronJob both firing would double-trigger runs; the run key deduplicates them, but relying
   on that for normal operation hides real duplicate-trigger bugs.
2. `replicas: 1` for the orchestrator, with no autoscaler, while import previews live in memory
   (`apps/orchestrator/src/services/previewStore.ts`) and the Telegram poller runs per process.
3. `ALLOWED_ORIGINS` must name the address the browser uses (`http://traders.localhost`), and
   `APP_ENV` must not be `production` while the cluster serves plain http - production marks the
   session cookie `Secure`.

Still to come in M7: the services with probes (PR 3), the Ingress (PR 4), CronJobs for every run
kind (PR 5), the AI service's autoscaler (PR 6).

## Images

A cluster runs the production images, built by `bash scripts/build-images.sh` and tagged with the
short commit hash (`-dirty` when the tree has uncommitted changes). `k8s-up.sh` builds them and
copies them into the kind node with `kind load docker-image` - the node is a separate container
with its own image store and cannot see the images on your Mac.

- `traders/ai-service` - the AI service; the same image runs the migration and loader Jobs with a
  different command;
- `traders/orchestrator`;
- `traders/web` - the built bundle behind nginx. The bundle calls `/api`, and nginx forwards
  `/api/*` to the Service named `orchestrator` with the prefix removed, so the browser only ever
  talks to one origin. nginx looks that name up once, at start, and exits if it does not exist yet.

CI builds the web image and checks the proxy (`scripts/check-web-image.sh`) on every PR.

## Checking on it

```bash
kubectl --context kind-traders -n traders get pods                 # what runs
kubectl --context kind-traders -n traders logs job/migrate         # a Job's output
kubectl --context kind-traders -n traders logs job/corpus -c wait-for-schema
kubectl --context kind-traders -n traders exec postgres-0 -- psql -U traders -d traders
```
