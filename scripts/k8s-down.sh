#!/usr/bin/env bash
# =============================================================================
# k8s-down.sh - delete the local kind cluster `traders`, and everything in it.
#
# The cluster's database lives on a disk inside the kind node, so this deletes
# the cluster's data too - which is why it backs the database up to this Mac
# first (scripts/db-backup.sh) and deletes nothing if that backup fails. It does
# not touch the compose stack, its database, or
# infra/k8s/overlays/kind/secrets.env - which the next k8s-up.sh reuses, so a
# recreated cluster gets the same secrets.
#
# Usage:
#   bash scripts/k8s-down.sh                # backs up, then asks first
#   bash scripts/k8s-down.sh --yes          # for scripts and CI
#   bash scripts/k8s-down.sh --no-backup    # when the database is not worth keeping
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"
# shellcheck source=scripts/lib/backups.sh
source "$REPO_ROOT/scripts/lib/backups.sh"

YES=false
BACKUP=true
for arg in "$@"; do
  case "$arg" in
    --yes) YES=true ;;
    --no-backup) BACKUP=false ;;
    *) fail "unknown option: $arg (expected --yes or --no-backup)" ;;
  esac
done

CLUSTER=traders
require_command kind "brew install kind  (https://kind.sigs.k8s.io)"

if ! kind get clusters 2> /dev/null | grep -qx "$CLUSTER"; then
  ok "no cluster '$CLUSTER' to delete"
  exit 0
fi

# Before asking, so the question is asked about a database that is already safe.
if [ "$BACKUP" = true ]; then
  if backup_target_available kind; then
    bash "$REPO_ROOT/scripts/db-backup.sh" --target kind ||
      fail "the backup failed, so nothing was deleted (--no-backup deletes without one)"
  else
    warn "the cluster's database is not running, so it cannot be backed up first"
    [ "$YES" = true ] || warn "the newest backup is in $(backup_target_dir kind), if there is one"
  fi
fi

if [ "$YES" != true ]; then
  warn "This deletes the kind cluster '$CLUSTER' and its database. The compose stack is not affected."
  printf '   Type "yes" to continue: '
  read -r reply
  [ "$reply" = "yes" ] || fail "aborted"
fi

kind delete cluster --name "$CLUSTER"
ok "cluster '$CLUSTER' deleted"
