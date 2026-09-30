#!/usr/bin/env bash
# =============================================================================
# k8s-up.sh - deploy Traders to a local Kubernetes cluster (kind), in one command.
#
# What this does, in order:
#   1. Creates the kind cluster `traders` if it does not exist (infra/k8s/kind).
#   2. Builds the production images for this checkout (scripts/build-images.sh)
#      and copies them into the cluster - kind's node is a separate container
#      with its own image store, and cannot see the images on your Mac.
#   3. Writes infra/k8s/overlays/kind/secrets.env on first run: fresh random
#      secrets, including the cluster's own sign-in passphrase, printed once
#      (read it again with: grep APP_PASSPHRASE infra/k8s/overlays/kind/secrets.env).
#      The cluster needs no .env. Kept after that - the database password in
#      particular is fixed when Postgres first creates its data directory.
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

# The ingress controller: cluster infrastructure, applied before the app.
say "Applying the ingress controller (Traefik)"
kubectl --context "$CONTEXT" apply -f "$K8S/kind/traefik.yaml"

# --- 2. images ---------------------------------------------------------------
IMAGE_TAG="${IMAGE_TAG:-$(image_tag)}"
export IMAGE_TAG
bash "$REPO_ROOT/scripts/build-images.sh"
say "Loading images into the cluster"
for image in ai-service orchestrator web; do
  kind load docker-image "traders/$image:$IMAGE_TAG" --name "$CLUSTER"
done

# --- 3. secrets --------------------------------------------------------------
if [ -f "$SECRETS_FILE" ]; then
  ok "using existing $(basename "$SECRETS_FILE")"
else
  say "Generating $(basename "$SECRETS_FILE") (git-ignored; kept from now on)"
  passphrase="cluster-$(openssl rand -hex 6)"
  db_password="$(openssl rand -hex 16)"
  umask 077
  cat > "$SECRETS_FILE" << EOF
APP_PASSPHRASE=$passphrase
SESSION_SECRET=$(openssl rand -hex 32)
INTERNAL_API_KEY=$(openssl rand -hex 16)
POSTGRES_PASSWORD=$db_password
DATABASE_URL=postgresql://traders:$db_password@postgres:5432/traders
EOF
  printf '     %sSign-in passphrase for the cluster: %s%s%s\n' "$C_DIM" "$C_BOLD" "$passphrase" "$C_RESET"
fi

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

say "Applying manifests for $IMAGE_TAG"
# A Job cannot be edited after creation, and each deploy should run them again.
kc delete job migrate corpus universe --ignore-not-found --wait=true > /dev/null 2>&1 || true
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

say "Cluster state"
kc get pods
echo
ok "Traders is running in the cluster: http://traders.localhost"
echo "     sign in with: grep APP_PASSPHRASE infra/k8s/overlays/kind/secrets.env"
