# Kubernetes manifests

Milestone 7. Traders on a local [kind](https://kind.sigs.k8s.io) cluster: Kubernetes running
inside one Docker container on your machine, next to (and independent of) the compose stack.

```bash
brew install kind kubectl
bash scripts/k8s-up.sh      # create the cluster if needed, build, load, deploy
bash scripts/k8s-down.sh    # delete the cluster and its database (asks first)
```

Then open **http://traders.localhost** and sign in with the cluster's passphrase
(`grep APP_PASSPHRASE infra/k8s/overlays/kind/secrets.env`).

Every `kubectl` command below names the context, so it cannot reach another cluster:
`kubectl --context kind-traders -n traders get pods`.

## Layout

```
infra/k8s/
  kind/cluster.yaml          the cluster itself: one node, port 80, the universe mount
  kind/traefik.yaml          the ingress controller (cluster infrastructure, not the app)
  base/                      what Traders is, on any cluster
    kustomization.yaml         lists the files; sets the namespace; generates the ConfigMap
    config.env                 non-secret settings (keyless defaults)
    namespace.yaml, postgres.yaml, redis.yaml, jobs.yaml
    ai-service.yaml, orchestrator.yaml, web.yaml, ingress.yaml
    cronjobs.yaml              one CronJob per run kind
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
| Ingress `traders` | a routing rule: host `traders.localhost` goes to Service `web` | the front door; one rule, because nginx already splits page from API |
| Ingress controller (Traefik) | the program that reads Ingress rules and routes the traffic | an Ingress alone does nothing |
| IngressClass `traefik` | names a controller; marked as the cluster default | the app's Ingress names no controller, so it is portable |
| ServiceAccount + ClusterRole + binding (RBAC) | an identity for a pod, and what it may ask the Kubernetes API | Traefik must read Ingresses and Services; the API refuses anything not granted |
| Service type NodePort | opens a port on the node itself | how traffic from outside the cluster gets in at all |
| CronJob `run-<kind>` (9) | creates a Job on a timetable | scheduled runs: each Job POSTs one run kind to `/internal/runs`, replacing the in-process timer |

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

1. `SCHEDULER_ENABLED=false` on the orchestrator (in `config.env`). The CronJobs trigger runs;
   the in-process timer and a CronJob both firing would double-trigger them - the run key
   deduplicates, but relying on that for normal operation hides real duplicate-trigger bugs.
2. **Every run kind the local timer offers has a CronJob at the same rhythm.**
   `apps/orchestrator/test/cronJobContract.test.ts` fails the build otherwise - a kind added to
   `scheduler.ts` alone would run on every laptop and never in a cluster.
3. `replicas: 1` for the orchestrator, with no autoscaler, while import previews live in memory
   (`apps/orchestrator/src/services/previewStore.ts`) and the Telegram poller runs per process.
4. `ALLOWED_ORIGINS` must name the addresses the browser uses (`http://traders.localhost`), and
   `APP_ENV` must not be `production` while the cluster serves plain http - production marks the
   session cookie `Secure`.

Still to come in M7: the AI service's autoscaler (PR 6).

## Scheduled runs

Nine CronJobs, one per run kind, each creating a small Job that POSTs `{kind, trigger: "cronjob"}`
to the orchestrator's `/internal/runs` inside the cluster - the same endpoint the local timer
calls. The schedules copy the timer's rhythm (every 15 minutes or every hour, backfill first and
the digest last), and the run key decides whether a trigger does work: a second trigger in the
same bucket is answered `skipped`, which is a success. Why "ask often" rather than "once a day at
a set time": a trigger that fires once per period is silently lost if the cluster was down at that
minute; an hourly ask of a daily bucket catches up by itself. The reasoning per field is in the
header of `base/cronjobs.yaml`.

```bash
kubectl --context kind-traders -n traders get cronjobs            # schedules, last run
kubectl --context kind-traders -n traders get jobs -l app=run-trigger
kubectl --context kind-traders -n traders logs job/<job-name>     # the orchestrator's answer
# Run one now, outside its schedule (the run key still applies):
kubectl --context kind-traders -n traders create job --from=cronjob/run-backfill backfill-now
# Pause one, or resume it:
kubectl --context kind-traders -n traders patch cronjob run-news-collect -p '{"spec":{"suspend":true}}'
```

Every run is recorded in the `runs` table with `trigger = 'cronjob'`.

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

## Reaching it

```
browser -> http://traders.localhost  (127.0.0.1:80 on the Mac; *.localhost needs no hosts entry)
  -> kind maps host port 80 to node port 30080           (kind/cluster.yaml)
  -> the NodePort Service hands it to Traefik            (kind/traefik.yaml)
  -> Traefik matches the Ingress rule, forwards to `web` (base/ingress.yaml)
  -> nginx serves the page, or forwards /api/* to `orchestrator`
```

The mapping listens on 127.0.0.1 only: other machines on your network cannot reach the cluster.
`traders.localhost` is its own hostname, so its session cookie never collides with the compose
app's on `127.0.0.1` - a browser keeps cookies per host, not per port.

`/api/internal/*` is not reachable through the front door (nginx answers 404). To reach the
orchestrator itself - for the smoke test, or to trigger a run by hand - forward its port:

```bash
kubectl --context kind-traders -n traders port-forward service/orchestrator 8089:8080
```

A port-forward attaches to one pod when it starts, so it dies when a deploy replaces that pod -
start it again. The end-to-end smoke test runs against the cluster (it replaces the cluster's
holdings with the demo portfolio - never point it at a database you care about):

```bash
SMOKE_ENV_FILE=infra/k8s/overlays/kind/secrets.env SMOKE_ORIGIN=http://traders.localhost \
  bash scripts/smoke-test.sh http://127.0.0.1:8089
```

## If something does not answer

- **`k8s-up.sh` says the cluster "predates the port-80 mapping".** Port mappings are fixed when a
  cluster is created: `bash scripts/k8s-down.sh && bash scripts/k8s-up.sh`.
- **`http://traders.localhost` resets the connection.** Seen once, on the first cluster created
  with the mapping, and not reproduced: Traefik answered from inside Docker's network but not from
  the Mac, and a freshly created cluster worked. Recreate the cluster as above. Check first that
  Traefik is running without `forbidden` errors:
  `kubectl --context kind-traders -n traefik logs deploy/traefik`.
- **Something else holds port 80** (`lsof -nP -iTCP:80 -sTCP:LISTEN`): `kind create` fails with
  "address already in use". Stop it, or change `hostPort` in `kind/cluster.yaml` and use
  `http://traders.localhost:<port>` - and add that origin to `ALLOWED_ORIGINS`.

## Checking on it

```bash
kubectl --context kind-traders -n traders get pods                 # what runs
kubectl --context kind-traders -n traders logs job/migrate         # a Job's output
kubectl --context kind-traders -n traders logs job/corpus -c wait-for-schema
kubectl --context kind-traders -n traders exec postgres-0 -- psql -U traders -d traders
```
