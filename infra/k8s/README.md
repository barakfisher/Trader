# Kubernetes manifests

Milestone 7. What lands here:

- `Deployment` + `Service` for `orchestrator`, `ai-service` and the nginx-served `web` bundle,
- `ConfigMap` for non-secret configuration, `Secret` for keys (never baked into an image),
- `CronJob`s posting to `POST /internal/runs` with `x-internal-key` — the same entrypoint the
  local scheduler uses, so there is exactly one trigger path (see DESIGN.md section 2),
- `HorizontalPodAutoscaler` for both services,
- a migration `Job` that must complete before the services roll, mirroring the `migrate`
  container in the compose file,
- liveness on `/healthz` and readiness on `/readyz`.

Two things to carry over when writing these:

1. Set `SCHEDULER_ENABLED=false` on the orchestrator Deployment. The in-process timer and a
   CronJob both firing would double-trigger runs; the run key deduplicates them, but relying on
   that for normal operation hides real duplicate-trigger bugs.
2. Keep `replicas: 1` for the orchestrator until import previews move from memory to Redis
   (see `apps/orchestrator/src/services/previewStore.ts`).

## Images

A cluster runs the production images, built by `bash scripts/build-images.sh` and tagged with the
short commit hash (`-dirty` when the tree has uncommitted changes):

- `traders/ai-service` - the AI service; the same image runs the migration and loader Jobs with a
  different command;
- `traders/orchestrator`;
- `traders/web` - the built bundle behind nginx. The bundle calls `/api`, and nginx forwards
  `/api/*` to the Service named `orchestrator` with the prefix removed, so the browser only ever
  talks to one origin. nginx looks that name up once, at start, and exits if it does not exist yet.

CI builds the web image and checks the proxy (`scripts/check-web-image.sh`) on every PR.
