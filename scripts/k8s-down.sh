#!/usr/bin/env bash
# =============================================================================
# k8s-down.sh - delete the local kind cluster `traders`, and everything in it.
#
# The cluster's database lives on a disk inside the kind node, so this deletes
# the cluster's data too. It does not touch the compose stack, its database, or
# infra/k8s/overlays/kind/secrets.env - which the next k8s-up.sh reuses, so a
# recreated cluster gets the same secrets.
#
# Usage:
#   bash scripts/k8s-down.sh         # asks first
#   bash scripts/k8s-down.sh --yes   # for scripts and CI
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"

CLUSTER=traders
require_command kind "brew install kind  (https://kind.sigs.k8s.io)"

if ! kind get clusters 2> /dev/null | grep -qx "$CLUSTER"; then
  ok "no cluster '$CLUSTER' to delete"
  exit 0
fi

if [ "${1:-}" != "--yes" ]; then
  warn "This deletes the kind cluster '$CLUSTER' and its database. The compose stack is not affected."
  printf '   Type "yes" to continue: '
  read -r reply
  [ "$reply" = "yes" ] || fail "aborted"
fi

kind delete cluster --name "$CLUSTER"
ok "cluster '$CLUSTER' deleted"
