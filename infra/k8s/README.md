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
