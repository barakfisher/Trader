#!/usr/bin/env bash
# =============================================================================
# k8s-up.sh - deploy Traders to a local Kubernetes cluster (kind), in one command.
#
# What this does, in order:
#   1. Creates the kind cluster `traders` if it does not exist (infra/k8s/kind).
#   2. Builds the production images for this checkout (scripts/build-images.sh)
#      and copies them into the cluster - kind's node is a separate container
#      with its own image store, and cannot see the images on your Mac.
#   3. Writes infra/k8s/overlays/kind/secrets.env, and owner.env with the
#      database owner's password (read by Postgres and migrate alone; D300), on
#      first run: fresh random secrets; the admin's sign-in password is set after the rollout and
#      printed once (replace it with: bash scripts/admin-password.sh kind <email>).
#      The cluster needs no .env. Kept after that - the database password in
#      particular is fixed when Postgres first creates its data directory - and
#      recovered from the cluster's own Secret when the file is missing but the
#      cluster is not (a worktree, a fresh clone, a deleted file).
#   4. Applies the manifests for the commit being deployed, re-running the
#      migrate / corpus / universe Jobs.
#   5. Waits for Postgres, Redis and the migration, reports the loaders, then
#      waits for the three services to be ready.
#
# Every kubectl call names the context `kind-traders`, so this script cannot
# touch any other cluster your kubeconfig knows about.
#
# Usage:
#   bash scripts/k8s-up.sh
#   UNIVERSE_DIR=/path/to/data/universe bash scripts/k8s-up.sh   # first run only
#
# UNIVERSE_DIR is where the universe loader finds this machine's licensed
# descriptions (default: this checkout's data/universe). It is mounted when the
# cluster is created; to change it, delete the cluster (k8s-down.sh) first.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"
# shellcheck source=scripts/lib/backups.sh
source "$REPO_ROOT/scripts/lib/backups.sh"

CLUSTER=traders
CONTEXT="kind-$CLUSTER"
NAMESPACE=traders
K8S="$REPO_ROOT/infra/k8s"
SECRETS_FILE="$K8S/overlays/kind/secrets.env"
DEPLOY_DIR="$K8S/.deploy"
UNIVERSE_DIR="${UNIVERSE_DIR:-$REPO_ROOT/data/universe}"

kc() { kubectl --context "$CONTEXT" --namespace "$NAMESPACE" "$@"; }

require_command docker "Docker Desktop: https://www.docker.com/products/docker-desktop/"
require_command kind "brew install kind  (https://kind.sigs.k8s.io)"
require_command kubectl "brew install kubectl"
docker info > /dev/null 2>&1 || fail "Docker is installed but not running. Start Docker Desktop and try again."

# --- 1. the cluster ----------------------------------------------------------
if kind get clusters 2> /dev/null | grep -qx "$CLUSTER"; then
  ok "cluster '$CLUSTER' exists"
  # Port mappings are fixed at creation, so a cluster made before the Ingress
  # existed can never be reached on port 80. Say so, rather than deploy into
  # a cluster whose front door is missing.
  if [ -z "$(docker port "$CLUSTER-control-plane" 30080/tcp 2> /dev/null)" ]; then
    fail "cluster '$CLUSTER' predates the port-80 mapping - recreate it: bash scripts/k8s-down.sh && bash scripts/k8s-up.sh"
  fi
else
  [ -d "$UNIVERSE_DIR" ] || fail "UNIVERSE_DIR does not exist: $UNIVERSE_DIR"
  UNIVERSE_DIR="$(cd "$UNIVERSE_DIR" && pwd)"
  if [ ! -f "$UNIVERSE_DIR/descriptions.local.jsonl" ]; then
    warn "no descriptions.local.jsonl in $UNIVERSE_DIR - topic resolution will answer 'unavailable'"
  fi
  say "Creating kind cluster '$CLUSTER' (universe from $UNIVERSE_DIR)"
  cluster_config="$(mktemp)"
  sed "s|__UNIVERSE_DIR__|$UNIVERSE_DIR|" "$K8S/kind/cluster.yaml" > "$cluster_config"
  kind create cluster --config "$cluster_config" --wait 120s
  rm -f "$cluster_config"
fi

# Cluster infrastructure, applied before the app: the ingress controller, and
# metrics-server, which the AI service's autoscaler reads.
say "Applying the ingress controller (Traefik) and metrics-server"
kubectl --context "$CONTEXT" apply -f "$K8S/kind/traefik.yaml"
kubectl --context "$CONTEXT" apply -k "$K8S/kind/metrics-server"

# --- 2. images ---------------------------------------------------------------
IMAGE_TAG="${IMAGE_TAG:-$(image_tag)}"
export IMAGE_TAG
bash "$REPO_ROOT/scripts/build-images.sh"
say "Loading images into the cluster"
for image in ai-service orchestrator web; do
  kind load docker-image "traders/$image:$IMAGE_TAG" --name "$CLUSTER"
done

# --- 3. secrets --------------------------------------------------------------
# Two files, two Secrets (D300): secrets.env -> `traders-secrets`, which every
# pod loads, and owner.env -> `traders-owner`, the database owner's password,
# which only Postgres and the migrate Job read.
#
# A missing file next to a cluster that already has a database must not be
# regenerated: Postgres keeps the password it was created with, and a new one
# would lock the migrations out. Each file is recovered from the Secret the
# running cluster reads it from instead (independent task 13; the commands are
# docs/RUNBOOK.md section 1's). A worktree, a fresh clone or a deleted file all
# arrive here. A cluster from before the split keeps every key in
# `traders-secrets`; recovered, its owner lines are moved below like any older file's.

# recover_secret <file> <Secret name>: the Secret's keys as an env file, mode 600.
recover_secret() {
  say "Recovering $(basename "$1") from the cluster's Secret $2"
  (
    umask 077
    kc get secret "$2" -o json | python3 -c '
import base64, json, sys
for key, value in sorted(json.load(sys.stdin)["data"].items()):
    print(f"{key}={base64.b64decode(value).decode()}")
' > "$1.new"
  )
  mv "$1.new" "$1"
}

has_database() { kc get pvc data-postgres-0 > /dev/null 2>&1; }

OWNER_FILE="$K8S/overlays/kind/owner.env"

if [ ! -f "$SECRETS_FILE" ]; then
  # The Secret the orchestrator loads whole: `traders-secrets`, by its hashed name.
  app_secret="$(kc get deployment orchestrator -o \
    jsonpath='{.spec.template.spec.containers[0].envFrom[*].secretRef.name}' 2> /dev/null || true)"
  if [ -n "$app_secret" ] && kc get secret "$app_secret" > /dev/null 2>&1; then
    recover_secret "$SECRETS_FILE" "$app_secret"
    grep -q '^SESSION_SECRET=' "$SECRETS_FILE" \
      || fail "Secret $app_secret has no SESSION_SECRET - see docs/RUNBOOK.md section 1"
  elif has_database; then
    fail "the cluster has a database (data-postgres-0) but no Secret to recover its keys from; new secrets would lock the services out. See docs/RUNBOOK.md section 1, or start over: bash scripts/k8s-down.sh"
  fi
fi

if [ ! -f "$OWNER_FILE" ] && ! grep -qs '^POSTGRES_PASSWORD=' "$SECRETS_FILE"; then
  # The Secret Postgres reads its password from: `traders-owner`, or before the
  # split `traders-secrets` - only the owner's keys are kept either way.
  owner_secret="$(kc get statefulset postgres -o \
    jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="POSTGRES_PASSWORD")].valueFrom.secretKeyRef.name}' \
    2> /dev/null || true)"
  if [ -n "$owner_secret" ] && kc get secret "$owner_secret" > /dev/null 2>&1; then
    recover_secret "$OWNER_FILE" "$owner_secret"
    owner_keys="$(grep -E "$OWNER_SECRET_KEYS" "$OWNER_FILE" || true)"
    printf '%s\n' "$owner_keys" > "$OWNER_FILE"
    if ! grep -q '^POSTGRES_PASSWORD=' "$OWNER_FILE"; then
      rm -f "$OWNER_FILE"
      fail "Secret $owner_secret has no POSTGRES_PASSWORD - not writing $(basename "$OWNER_FILE"); see docs/RUNBOOK.md section 1"
    fi
  elif has_database; then
    fail "the cluster has a database (data-postgres-0) but no Secret to recover its owner's password from. See docs/RUNBOOK.md section 1, or start over: bash scripts/k8s-down.sh"
  else
    say "Generating $(basename "$OWNER_FILE") (git-ignored; kept from now on)"
    db_password="$(openssl rand -hex 16)"
    (
      umask 077
      printf 'POSTGRES_PASSWORD=%s\nMIGRATION_DATABASE_URL=postgresql://traders:%s@postgres:5432/traders\n' \
        "$db_password" "$db_password" > "$OWNER_FILE"
    )
  fi
fi

if [ -f "$SECRETS_FILE" ]; then
  ok "using existing $(basename "$SECRETS_FILE")"
  # A file written before the app role existed (migration 0033): keep every
  # value, add the app role's password, and point DATABASE_URL at it. The owner
  # password is untouched, so the running Postgres still accepts it.
  if ! grep -q '^APP_DB_PASSWORD=' "$SECRETS_FILE"; then
    say "Adding the app role to $(basename "$SECRETS_FILE")"
    app_password="$(openssl rand -hex 16)"
    (
      umask 077
      grep -v '^DATABASE_URL=' "$SECRETS_FILE" > "$SECRETS_FILE.new"
      printf 'APP_DB_PASSWORD=%s\n' "$app_password" >> "$SECRETS_FILE.new"
      printf 'DATABASE_URL=postgresql://traders_app:%s@postgres:5432/traders\n' "$app_password" >> "$SECRETS_FILE.new"
    )
    mv "$SECRETS_FILE.new" "$SECRETS_FILE"
  fi
  # A file from before the owner's own Secret (D300): its owner lines move to owner.env.
  split_owner_secret "$SECRETS_FILE" "$OWNER_FILE"
else
  say "Generating $(basename "$SECRETS_FILE") (git-ignored; kept from now on)"
  app_password="$(openssl rand -hex 16)"
  (
    umask 077
    printf 'SESSION_SECRET=%s\nINTERNAL_API_KEY=%s\nAPP_DB_PASSWORD=%s\nDATABASE_URL=postgresql://traders_app:%s@postgres:5432/traders\n' \
      "$(openssl rand -hex 32)" "$(openssl rand -hex 16)" "$app_password" "$app_password" > "$SECRETS_FILE"
  )
fi
# The URL migrate connects with, for a file that has only the password (D300).
ensure_migration_url "$OWNER_FILE" traders traders

# --- 4. apply ----------------------------------------------------------------
# A per-deploy kustomization naming the image tag; git-ignored. It must sit
# inside the repository because Kustomize refuses absolute resource paths.
mkdir -p "$DEPLOY_DIR"
cat > "$DEPLOY_DIR/kustomization.yaml" << EOF
# Written by scripts/k8s-up.sh for $IMAGE_TAG. Do not edit; do not commit.
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../overlays/kind
images:
  - name: traders/ai-service
    newTag: "$IMAGE_TAG"
  - name: traders/orchestrator
    newTag: "$IMAGE_TAG"
  - name: traders/web
    newTag: "$IMAGE_TAG"
EOF

# The phone's way in (docs/PHONE-ACCESS.md): this Mac's Tailscale name, e.g.
# mac.tail1234.ts.net. `tailscale serve` hands https://<name> to 127.0.0.1:80
# keeping that name as the Host, so the Ingress needs a rule for it, and the
# orchestrator must accept the page's Origin. Per machine, so it is added here,
# in the git-ignored per-deploy file, never in the committed base. Without
# Tailscale (or with TAILNET_HOST=none) nothing is added and only
# traders.localhost answers.
TAILNET_HOST="${TAILNET_HOST:-}"
if [ -z "$TAILNET_HOST" ] && command -v tailscale > /dev/null 2>&1; then
  TAILNET_HOST="$(tailscale status --json 2> /dev/null | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))
except Exception:
    pass
' || true)"
fi
if [ -n "$TAILNET_HOST" ] && [ "$TAILNET_HOST" != "none" ]; then
  ok "phone access: https://$TAILNET_HOST (Tailscale)"
  cat >> "$DEPLOY_DIR/kustomization.yaml" << EOF
configMapGenerator:
  - name: traders-config
    behavior: merge
    literals:
      - ALLOWED_ORIGINS=http://traders.localhost,https://$TAILNET_HOST
patches:
  - target:
      kind: Ingress
      name: traders
    patch: |-
      - op: add
        path: /spec/rules/-
        value:
          host: $TAILNET_HOST
          http:
            paths:
              - path: /
                pathType: Prefix
                backend:
                  service:
                    name: web
                    port:
                      name: http
EOF
fi

say "Applying manifests for $IMAGE_TAG"
# A Job cannot be edited after creation, and each deploy should run them again.
kc delete job migrate corpus universe --ignore-not-found --wait=true > /dev/null 2>&1 || true
# `apply` does not prune, so a CronJob renamed in cronjobs.yaml would keep
# firing under its old name with a kind the orchestrator now refuses. Listed
# here when a CronJob is renamed: run-session-sweep became run-auth-sweep (0074).
kc delete cronjob run-session-sweep --ignore-not-found > /dev/null 2>&1 || true
kubectl --context "$CONTEXT" apply -k "$DEPLOY_DIR"

# --- 5. wait -----------------------------------------------------------------
# Prints Complete or Failed once the Job reaches either; exits non-zero on timeout.
wait_for_job() {
  local job="$1" timeout="$2" state
  for _ in $(seq 1 "$timeout"); do
    state="$(kc get job "$job" -o jsonpath='{.status.conditions[?(@.status=="True")].type}' 2> /dev/null || true)"
    case "$state" in
      *Complete*) echo Complete; return 0 ;;
      *Failed*) echo Failed; return 0 ;;
    esac
    sleep 1
  done
  echo "Timeout"
  return 1
}

say "Waiting for Postgres and Redis"
kc rollout status statefulset/postgres --timeout=300s
kc rollout status statefulset/redis --timeout=120s

say "Waiting for the migration"
state="$(wait_for_job migrate 300 || true)"
if [ "$state" != "Complete" ]; then
  kc logs job/migrate --all-containers --tail=40 || true
  fail "migration did not complete ($state)"
fi
ok "migration complete"

# The loaders never block the app (see base/jobs.yaml); report, do not fail.
for job in corpus universe; do
  state="$(wait_for_job "$job" 600 || true)"
  if [ "$state" = "Complete" ]; then
    ok "$job loaded"
  else
    warn "$job did not complete ($state) - the app still starts; see: kubectl --context $CONTEXT -n $NAMESPACE logs job/$job"
  fi
done

say "Waiting for the services"
# `rollout status` returns once the Deployment's new pods pass their readiness
# probes - the same signal the Service uses to send them traffic.
for deployment in ai-service orchestrator web; do
  kc rollout status "deployment/$deployment" --timeout=300s
done
kubectl --context "$CONTEXT" -n traefik rollout status deployment/traefik --timeout=120s
kubectl --context "$CONTEXT" -n kube-system rollout status deployment/metrics-server --timeout=120s

ensure_admin_password kind

say "Cluster state"
kc get pods
echo
ok "Traders is running in the cluster: http://traders.localhost"
echo "     mail it sent (Mailpit, this Mac only): http://mailpit.localhost"
if [ -n "$TAILNET_HOST" ] && [ "$TAILNET_HOST" != "none" ]; then
  echo "     on your phone (Tailscale): https://$TAILNET_HOST"
  # `serve` is set once and kept across restarts; say so if it never was.
  if ! tailscale serve status 2> /dev/null | grep -q '127.0.0.1:80'; then
    warn "tailscale serve is not forwarding to the cluster yet - run once: tailscale serve --bg http://127.0.0.1:80"
  fi
fi
echo "     sign in as the admin; lost the password? bash scripts/admin-password.sh kind <email>"
warn_if_backup_stale kind
