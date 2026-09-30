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
    ai-service.yaml, orchestrator.yaml, web.yaml
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
| Deployment `ai-service`, `orchestrator`, `web` | keeps N identical pods running from one image; replaces them when the image changes | the three services; a crashed pod is replaced without anyone noticing |
| Service `ai-service`, `orchestrator`, `web` | as above | `AI_SERVICE_URL` names `ai-service`; nginx names `orchestrator` |
| Probes (startup, liveness, readiness) | questions the node keeps asking each container | see below |

**Ordering without `depends_on`.** Everything starts the moment it is applied. `migrate` waits for
Postgres (`pg_isready`); the loaders wait until the schema is at their image's migration head
(`services/ai/scripts/wait_for_schema.py`), which is also how the services will be guarded - a pod
restarted a week later checks the schema again rather than relying on a Job it never saw. The
loaders failing never stops the app, as in compose.

**Probes.** Three questions, three different consequences:

| Probe | Asks | On failure | Traders checks |
|---|---|---|---|
| startup | has it finished starting? | keeps waiting (up to 60 s), then restarts | `/healthz` |
| liveness | is the process alive? | restarts the container | `/healthz` - depends on nothing, because restarting never fixes a dependency |
| readiness | should traffic come here? | the Service stops routing to it; **no restart** | `/readyz` |

Readiness gates on a service's *own* store only. The AI service answers 503 without Redis; the
orchestrator answers 503 without Postgres and reports the AI service in the body only - otherwise
an AI outage would pull the orchestrator out of rotation too, and sign-in and every stored page
would go with it. Seen on the cluster: with Redis stopped, the AI pod went not-ready with 0
restarts, its Service had no endpoints, the orchestrator stayed ready (200, `degraded`), and both
recovered by themselves when Redis came back.

**Rollouts.** A Deployment's default is a rolling update: the new pod is ready before the old one
stops, so a deploy costs no downtime (`ai-service`, `web`). The orchestrator uses `Recreate`
instead - old pod first, then new - because two copies overlapping, even for seconds, would split
the in-memory import previews between them.

**`enableServiceLinks: false`, on every pod** (one patch in `base/kustomization.yaml`). By default
Kubernetes gives every pod a set of variables per Service, in an old Docker-links format. The
Service `ai-service` became `AI_SERVICE_PORT=tcp://10.96.x.x:8000`, which collided with the AI
service's own `AI_SERVICE_PORT` setting and stopped it at startup.

**Secrets.** `scripts/k8s-up.sh` writes `overlays/kind/secrets.env` on the first run: random
session and internal keys, a random database password, and the cluster's own sign-in passphrase,
printed once (`grep APP_PASSPHRASE infra/k8s/overlays/kind/secrets.env` to read it again). The
cluster needs no `.env`. The file is never rewritten, because Postgres reads the password only when
it first creates its data directory - a new password would lock the services out of the existing
database. To start over: `k8s-down.sh`, then delete the file.

**Settings.** `base/config.env` is keyless: Yahoo prices (no key needed), fixture news, fixture
embeddings, template narration, Telegram off. The compose stack keeps its own `.env`; the two
share no database, no Telegram bot and no GDELT downloads.

## Rules the remaining manifests must keep

1. `SCHEDULER_ENABLED=false` on the orchestrator (already in `config.env`). The in-process timer
   and a CronJob both firing would double-trigger runs; the run key deduplicates them, but relying
   on that for normal operation hides real duplicate-trigger bugs.
2. `replicas: 1` for the orchestrator, with no autoscaler, while import previews live in memory
   (`apps/orchestrator/src/services/previewStore.ts`) and the Telegram poller runs per process.
3. `ALLOWED_ORIGINS` must name the addresses the browser uses (`http://traders.localhost`, and
   the port-forward below), and
   `APP_ENV` must not be `production` while the cluster serves plain http - production marks the
   session cookie `Secure`.

Still to come in M7: the Ingress (PR 4), CronJobs for every run kind (PR 5), the AI service's
autoscaler (PR 6).

## Images

A cluster runs the production images, built by `bash scripts/build-images.sh` and tagged with the
short commit hash (`-dirty-<hash of the edits>` when the tree has uncommitted changes, so a redeploy of an edited tree always rolls the pods). `k8s-up.sh` builds them and
copies them into the kind node with `kind load docker-image` - the node is a separate container
with its own image store and cannot see the images on your Mac.

- `traders/ai-service` - the AI service; the same image runs the migration and loader Jobs with a
  different command;
- `traders/orchestrator`;
- `traders/web` - the built bundle behind nginx. The bundle calls `/api`, and nginx forwards
  `/api/*` to the Service named `orchestrator` with the prefix removed, so the browser only ever
  talks to one origin. nginx looks that name up once, at start, and exits if it does not exist yet.

CI builds the web image and checks the proxy (`scripts/check-web-image.sh`) on every PR.

## Reaching it (until the Ingress)

```bash
kubectl --context kind-traders -n traders port-forward service/web 8088:80   # the app
kubectl --context kind-traders -n traders port-forward service/orchestrator 8089:8080
```

A port-forward attaches to one pod when it starts, so it dies when a deploy replaces that pod -
start it again. And a browser keeps cookies per host, not per port: signing in at
`127.0.0.1:8088` replaces the compose app's session cookie at `127.0.0.1:5174`. The Ingress gives
the cluster its own hostname, which ends that.

The end-to-end smoke test runs against the cluster (it replaces the cluster's holdings with the
demo portfolio - never point it at a database you care about):

```bash
SMOKE_ENV_FILE=infra/k8s/overlays/kind/secrets.env SMOKE_ORIGIN=http://traders.localhost \
  bash scripts/smoke-test.sh http://127.0.0.1:8089
```

## Checking on it

```bash
kubectl --context kind-traders -n traders get pods                 # what runs
kubectl --context kind-traders -n traders logs job/migrate         # a Job's output
kubectl --context kind-traders -n traders logs job/corpus -c wait-for-schema
kubectl --context kind-traders -n traders exec postgres-0 -- psql -U traders -d traders
```
