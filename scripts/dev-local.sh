#!/usr/bin/env bash
# =============================================================================
# dev-local.sh - run the three application processes natively on your Mac,
# with only Postgres and Redis in containers.
#
# WHEN TO USE THIS ONE:
#   * You are writing application code (React, orchestrator, AI service) and
#     want the fastest edit-save-see loop. Changes apply in well under a second;
#     there is no image to rebuild and no container to restart.
#   * You want to attach a debugger, set breakpoints, or run a single test from
#     your IDE against the code as it actually runs.
#   * You want readable stack traces pointing at your real file paths, and
#     `console.log` / `print` showing up instantly.
#
# WHEN TO USE scripts/dev-docker.sh INSTEAD:
#   * Anything touching Dockerfiles, docker-compose, migrations or CI.
#   * Demoing, or checking that the system works the way it will in production.
#   * You just want it running and do not care about iteration speed.
#   * You would rather not install Python 3.12 and pnpm locally.
#
# WHY POSTGRES AND REDIS STILL RUN IN CONTAINERS:
#   Installing and version-managing them on macOS is exactly the pain Docker
#   removes, and neither is something you edit. You get native hot reload where
#   it pays off, and containers where they cost nothing.
#
# WHAT TO EXPECT:
#   Three processes in one terminal, their logs interleaved and colour-prefixed
#   [ai] [api] [web]. Ctrl-C stops all three cleanly. The containers keep
#   running, so your data survives; stop them with
#   `bash scripts/dev-docker.sh --stop`.
#
# Usage:
#   bash scripts/dev-local.sh            # start the local development loop
#   bash scripts/dev-local.sh --setup    # only install dependencies, then exit
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$REPO_ROOT/infra/compose/docker-compose.yml" --env-file "$REPO_ROOT/.env")

# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"

SETUP_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --setup) SETUP_ONLY=true ;;
    -h | --help)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) fail "unknown option: $arg (try --help)" ;;
  esac
done

require_command docker "Docker Desktop: https://www.docker.com/products/docker-desktop/"
require_command pnpm "install with: corepack enable && corepack prepare pnpm@latest --activate"
require_command uv "install with: curl -LsSf https://astral.sh/uv/install.sh | sh"
docker info > /dev/null 2>&1 || fail "Docker is installed but not running. Start Docker Desktop and try again."
require_env_file
load_env

# -----------------------------------------------------------------------------
# 1. Datastores in containers, application code on the host.
# -----------------------------------------------------------------------------
say "Starting Postgres and Redis, and applying migrations"
"${COMPOSE[@]}" up -d postgres redis
"${COMPOSE[@]}" run --rm migrate > /dev/null
ok "database is migrated"

# The containerised copies of the app would hold the ports this script needs,
# and running both would be confusing: two orchestrators, one database.
if "${COMPOSE[@]}" ps --services --filter status=running 2>/dev/null | grep -qE '^(ai-service|orchestrator|web)$'; then
  warn "The containerised app services are running; stopping them so this script can take over."
  "${COMPOSE[@]}" stop ai-service orchestrator web > /dev/null
fi

# -----------------------------------------------------------------------------
# 2. Dependencies.
# -----------------------------------------------------------------------------
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  say "Installing JavaScript dependencies"
  (cd "$REPO_ROOT" && pnpm install)
fi

if [ ! -x "$REPO_ROOT/services/ai/.venv/bin/python" ]; then
  say "Creating the Python environment (3.12)"
  (cd "$REPO_ROOT/services/ai" && uv venv --python 3.12 && uv pip install -e '.[dev]')
fi

if [ "$SETUP_ONLY" = true ]; then
  ok "Dependencies are installed. Run without --setup to start developing."
  exit 0
fi

# -----------------------------------------------------------------------------
# 3. Point the host processes at the containers' *published* ports.
#
# Inside Docker the services reach each other as "postgres:5432" on a private
# network. A process on your Mac is not on that network, so it must use
# 127.0.0.1 and the host port from .env, which may have been remapped to avoid
# a clash with another project.
# -----------------------------------------------------------------------------
export DATABASE_URL="postgresql://${POSTGRES_USER:-traders}:${POSTGRES_PASSWORD:-traders}@127.0.0.1:${POSTGRES_HOST_PORT:-5432}/${POSTGRES_DB:-traders}"
export REDIS_URL="redis://127.0.0.1:${REDIS_HOST_PORT:-6379}/0"
# Running natively, each process binds the host port directly - there is no
# port mapping in play, so the host port IS the port the process listens on.
AI_PORT="${AI_SERVICE_HOST_PORT:-8000}"
API_PORT="${ORCHESTRATOR_HOST_PORT:-8080}"
export ORCHESTRATOR_PORT="$API_PORT"
export AI_SERVICE_URL="http://127.0.0.1:${AI_PORT}"
export LOG_LEVEL="${LOG_LEVEL:-debug}"
# The in-process timer would fire snapshot runs while you are mid-edit.
export SCHEDULER_ENABLED=false

WEB_PORT="${WEB_HOST_PORT:-5173}"
API_URL="http://127.0.0.1:${API_PORT}"
export ALLOWED_ORIGINS="http://127.0.0.1:${WEB_PORT},http://localhost:${WEB_PORT},${ALLOWED_ORIGINS:-}"

# Vite only reads VITE_* variables from .env files next to the app, so write the
# API URL where it will definitely be picked up. The file is git-ignored.
printf '# Written by scripts/dev-local.sh. Safe to delete.\nVITE_API_BASE_URL=%s\n' "$API_URL" \
  > "$REPO_ROOT/apps/web/.env.local"

require_free_port "$AI_PORT" "the AI service"
require_free_port "$API_PORT" "the orchestrator"
require_free_port "$WEB_PORT" "the web dev server"

# -----------------------------------------------------------------------------
# 4. Run all three with prefixed, interleaved logs; Ctrl-C stops everything.
# -----------------------------------------------------------------------------
PIDS=()

cleanup() {
  echo
  say "Stopping the local processes (Postgres and Redis keep running)"
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2> /dev/null || true
  done
  wait 2> /dev/null || true
  ok "stopped. Containers: bash scripts/dev-docker.sh --stop"
}
trap cleanup EXIT INT TERM

start() {
  local label="$1" colour="$2" directory="$3"
  shift 3
  (
    cd "$directory"
    # stdbuf keeps the prefixing responsive instead of arriving in blocks.
    "$@" 2>&1 | while IFS= read -r line; do
      printf '%s[%s]%s %s\n' "$colour" "$label" "$C_RESET" "$line"
    done
  ) &
  PIDS+=("$!")
}

say "Starting the application processes"
start "ai " "$C_YELLOW" "$REPO_ROOT/services/ai" \
  .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$AI_PORT" --reload
wait_for_http "http://127.0.0.1:${AI_PORT}/healthz" 30 "ai-service"

start "api" "$C_BLUE" "$REPO_ROOT/apps/orchestrator" pnpm dev
wait_for_http "${API_URL}/healthz" 30 "orchestrator"

start "web" "$C_GREEN" "$REPO_ROOT/apps/web" pnpm dev --port "$WEB_PORT" --host 127.0.0.1
wait_for_http "http://127.0.0.1:${WEB_PORT}/" 30 "web"

print_urls
say "Editing any file reloads that process automatically. Ctrl-C stops all three."
echo

wait
