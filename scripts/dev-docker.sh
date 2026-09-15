#!/usr/bin/env bash
# =============================================================================
# dev-docker.sh - run the whole system in containers.
#
# WHEN TO USE THIS ONE (the default; use it unless you have a reason not to):
#   * You just want the app running: demo it, click around, import a portfolio.
#   * You are working on infrastructure: Dockerfiles, compose, migrations, or
#     anything that has to behave the same way in CI and in production.
#   * You want the environment CI uses, so "works on my machine" means something.
#   * A teammate or a fresh clone needs one command to get a working system.
#
# WHEN TO USE scripts/dev-local.sh INSTEAD:
#   * You are iterating on application code and want the fastest possible
#     edit-save-see loop, a debugger attached, or your IDE's test runner.
#   See the header of that script for the full comparison.
#
# What this does:
#   1. Creates .env from .env.example on first run, with generated secrets.
#   2. Builds images if needed and starts all five containers.
#   3. Waits until the stack is genuinely ready (not just "started").
#   4. Prints the URLs, using the host ports your .env actually asks for.
#
# Usage:
#   bash scripts/dev-docker.sh              # start (or restart) the stack
#   bash scripts/dev-docker.sh --rebuild    # force a rebuild of the images
#   bash scripts/dev-docker.sh --reset      # DESTROY the database, then start
#   bash scripts/dev-docker.sh --logs       # start, then follow the logs
#   bash scripts/dev-docker.sh --stop       # stop the stack, keep the data
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$REPO_ROOT/infra/compose/docker-compose.yml" --env-file "$REPO_ROOT/.env")

# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"

REBUILD=false
RESET=false
FOLLOW_LOGS=false

for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=true ;;
    --reset)   RESET=true ;;
    --logs)    FOLLOW_LOGS=true ;;
    --stop)
      require_env_file
      say "Stopping the stack (data is kept; use --reset to wipe it)"
      "${COMPOSE[@]}" down
      exit 0
      ;;
    -h | --help)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      fail "unknown option: $arg (try --help)"
      ;;
  esac
done

require_command docker "Docker Desktop: https://www.docker.com/products/docker-desktop/"
docker info > /dev/null 2>&1 || fail "Docker is installed but not running. Start Docker Desktop and try again."
require_env_file
load_env

if [ "$RESET" = true ]; then
  warn "--reset deletes the Postgres volume. Every holding and snapshot will be lost."
  printf '   Type "yes" to continue: '
  read -r reply
  [ "$reply" = "yes" ] || fail "aborted"
  "${COMPOSE[@]}" down -v
fi

say "Starting the stack"
if [ "$REBUILD" = true ]; then
  "${COMPOSE[@]}" up -d --build
else
  # --build only rebuilds when a Dockerfile or its build context changed.
  "${COMPOSE[@]}" up -d --build
fi

# The containers being "up" is not the same as the app being usable: migrations
# have to finish and both services have to answer their readiness probes.
wait_for_http "http://127.0.0.1:${ORCHESTRATOR_HOST_PORT:-8080}/readyz" 60 "orchestrator"
wait_for_http "http://127.0.0.1:${AI_SERVICE_HOST_PORT:-8000}/healthz" 30 "ai-service"
wait_for_http "http://127.0.0.1:${WEB_HOST_PORT:-5173}/" 60 "web"

echo
"${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
print_urls
say "Stop with: bash scripts/dev-docker.sh --stop"

if [ "$FOLLOW_LOGS" = true ]; then
  echo
  say "Following logs (Ctrl-C stops watching; the stack keeps running)"
  "${COMPOSE[@]}" logs -f --tail=20
fi
