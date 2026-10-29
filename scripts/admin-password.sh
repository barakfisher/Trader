#!/usr/bin/env bash
# =============================================================================
# Give the installation's admin an email and a password (D179).
#
#   bash scripts/admin-password.sh <compose|kind|local|prod> <email> [--if-unset] [--generate]
#
# Where the database is:
#   compose  the docker compose stack's orchestrator container (dev-docker.sh)
#   prod     the production host's orchestrator - run ON the server, in its
#            checkout, at your own terminal (docs/RUNBOOK.md section 8)
#   kind     the cluster's orchestrator pod (k8s-up.sh)
#   local    this machine, against compose's Postgres (dev-local.sh)
#
# The password is read from stdin when one is piped in; at a terminal, or with
# `--generate`, a random one is generated and printed once. It is never an
# argument, which would land in shell history and `ps`. Re-running replaces it
# and signs the admin out everywhere, so this is also the "I lost my password"
# path. `--if-unset` does nothing when the admin already has a password: the
# start scripts call it with both flags, so a first start prints a password and
# every later one leaves it alone.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"

usage() { fail "usage: bash scripts/admin-password.sh <compose|kind|local|prod> <email> [--if-unset] [--generate]"; }

[ $# -ge 2 ] || usage
TARGET="$1"
EMAIL="$2"
shift 2
IF_UNSET=false
GENERATE=false
[ -t 0 ] && GENERATE=true
for flag in "$@"; do
  case "$flag" in
    --if-unset) IF_UNSET=true ;;
    --generate) GENERATE=true ;;
    *) usage ;;
  esac
done

# Runs `pnpm admin:password <args>` where the database is, stdin passed through.
run_script() {
  case "$TARGET" in
    compose)
      docker compose -f "$REPO_ROOT/infra/compose/docker-compose.yml" --env-file "$REPO_ROOT/.env" \
        exec -T orchestrator pnpm --silent admin:password "$@"
      ;;
    prod)
      docker compose -f "$REPO_ROOT/infra/compose/docker-compose.prod.yml" --env-file "$REPO_ROOT/.env" \
        exec -T orchestrator pnpm --silent admin:password "$@"
      ;;
    kind)
      kubectl --context kind-traders --namespace traders \
        exec -i deploy/orchestrator -- pnpm --silent admin:password "$@"
      ;;
    local)
      # The same address dev-local.sh gives the orchestrator: compose's Postgres
      # on this machine's port, not the `postgres` host name .env holds for containers.
      [ -f "$REPO_ROOT/.env" ] && load_env
      (
        cd "$REPO_ROOT/apps/orchestrator"
        DATABASE_URL="postgresql://traders_app:${APP_DB_PASSWORD:-traders_app}@127.0.0.1:${POSTGRES_HOST_PORT:-5432}/${POSTGRES_DB:-traders}" \
          pnpm --silent admin:password "$@"
      )
      ;;
    *) usage ;;
  esac
}

if [ "$IF_UNSET" = true ] && [ "$(run_script --status < /dev/null)" = "set" ]; then
  ok "the admin already has a password"
  exit 0
fi

if [ "$GENERATE" = true ]; then
  password="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  printf '%s' "$password" | run_script --email "$EMAIL" > /dev/null
  ok "the admin signs in as ${C_BOLD}${EMAIL}${C_RESET}"
  printf '     %sPassword (shown once): %s%s%s\n' "$C_DIM" "$C_BOLD" "$password" "$C_RESET"
  printf '     %sLost it? Run: bash scripts/admin-password.sh %s %s%s\n' "$C_DIM" "$TARGET" "$EMAIL" "$C_RESET"
else
  run_script --email "$EMAIL" > /dev/null
  ok "the admin signs in as ${EMAIL}, with the password given on stdin"
fi
