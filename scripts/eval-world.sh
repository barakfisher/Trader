#!/usr/bin/env bash
# =============================================================================
# eval-world.sh - the agent-scan eval's frozen worlds, as files and databases (D421).
#
# Usage:
#   bash scripts/eval-world.sh up
#       Start the eval's own Postgres (a container, 127.0.0.1:55436) and its
#       own Redis (127.0.0.1:56379) if they are not running. Nothing else uses
#       them: a run empties its Redis database, so it is never a stack's.
#   bash scripts/eval-world.sh keep <dump name>
#       Copy a production dump, e.g. traders-prod-20261119T072136Z, from the
#       backups into the eval's folder. db-backup.sh keeps the newest 14 dumps
#       and deletes the rest; a world the eval compares against must outlive that.
#   bash scripts/eval-world.sh restore <dump name> <database>
#       Restore a kept dump into a database of the eval's Postgres, replacing an
#       earlier copy. The name must end in _ci.
#   bash scripts/eval-world.sh down
#       Remove both containers and their volumes, and so every database in
#       them. The kept dumps stay.
#
# A world is made whole by services/ai/scripts/freeze_agent_eval_world.py, which
# calls `keep` and `restore` and then fetches the closes the dump lacks; a run
# (scripts/run_agent_eval.py) calls `restore`. Neither touches compose, kind or
# production: these two containers are the only servers they write to.
#
# The kept dumps live in $TRADERS_EVAL_DIR (default ~/Backups/traders/eval),
# outside the repository for the reason every dump does: each holds every row
# of the database.
# =============================================================================
set -euo pipefail
# The name checks below use bracket ranges, which a locale may widen.
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"
# shellcheck source=scripts/lib/backups.sh
source "$REPO_ROOT/scripts/lib/backups.sh"

CONTAINER=traders-eval-ci
PORT=55436
IMAGE=pgvector/pgvector:pg16
REDIS_CONTAINER=traders-eval-redis
REDIS_PORT=56379
REDIS_IMAGE=redis:7-alpine
# The container's own user and password: local, disposable, and no secret of the
# installation. services/ai/scripts/agent_eval/frozen_world.py names the same URL.
PG_USER=traders
PG_PASSWORD=traders
EVAL_DIR="${TRADERS_EVAL_DIR:-$BACKUP_DIR/eval}"

psql_eval() { docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -At -U "$PG_USER" "$@"; }

running() { [ -n "$(docker ps --quiet --filter "name=^$1$" --filter status=running)" ]; }
exists() { [ -n "$(docker ps --all --quiet --filter "name=^$1$")" ]; }

up() {
  require_command docker "install Docker Desktop"
  if ! running "$REDIS_CONTAINER"; then
    if exists "$REDIS_CONTAINER"; then
      docker start "$REDIS_CONTAINER" > /dev/null
    else
      docker run --detach --name "$REDIS_CONTAINER" \
        --publish "127.0.0.1:$REDIS_PORT:6379" "$REDIS_IMAGE" > /dev/null
    fi
  fi
  if ! running "$CONTAINER"; then
    if exists "$CONTAINER"; then
      docker start "$CONTAINER" > /dev/null
    else
      docker run --detach --name "$CONTAINER" \
        --env POSTGRES_USER="$PG_USER" --env POSTGRES_PASSWORD="$PG_PASSWORD" \
        --env POSTGRES_DB=traders_ci --publish "127.0.0.1:$PORT:5432" "$IMAGE" > /dev/null
    fi
  fi
  local attempt
  for attempt in $(seq 1 30); do
    if docker exec "$CONTAINER" pg_isready --quiet -U "$PG_USER" -d traders_ci 2> /dev/null; then
      # The dumps grant rights to the application role, which lives in the
      # server, not in a database (see db-restore.sh).
      [ "$(psql_eval -d postgres -c "SELECT count(*) FROM pg_roles WHERE rolname = 'traders_app'")" = 1 ] ||
        psql_eval -d postgres -c "CREATE ROLE traders_app LOGIN PASSWORD '$PG_PASSWORD'"
      return 0
    fi
    sleep 1
  done
  fail "the eval's Postgres ($CONTAINER) did not become ready after $attempt seconds"
}

dump_name() {
  case "$1" in
    traders-*-[0-9]*T[0-9]*Z) ;;
    *) fail "not a dump name: '$1' (expected e.g. traders-prod-20261119T072136Z)" ;;
  esac
  case "$1" in
    *[!A-Za-z0-9-]*) fail "not a dump name: '$1'" ;;
  esac
}

keep() {
  local name="$1" target source
  dump_name "$name"
  target="${name#traders-}"
  target="${target%%-*}"
  source="$(backup_target_dir "$target")/$name.dump"
  mkdir -p "$EVAL_DIR"
  if [ -f "$EVAL_DIR/$name.dump" ]; then
    ok "$name.dump is already kept in $EVAL_DIR"
    return 0
  fi
  [ -f "$source" ] || fail "no such dump: $source (db-backup.sh may have pruned it; a pruned dump cannot be brought back)"
  # Under a temporary name first, so an interrupted copy is never mistaken for a world.
  cp "$source" "$EVAL_DIR/$name.dump.partial"
  mv "$EVAL_DIR/$name.dump.partial" "$EVAL_DIR/$name.dump"
  [ ! -f "${source%.dump}.counts" ] || cp "${source%.dump}.counts" "$EVAL_DIR/$name.counts"
  ok "kept $name.dump in $EVAL_DIR"
}

restore() {
  local name="$1" database="$2" dump
  dump_name "$name"
  case "$database" in
    *[!a-z0-9_]* | "") fail "not a database name: '$database'" ;;
    *_ci) ;;
    *) fail "refusing '$database': the eval restores only into databases whose name ends in _ci" ;;
  esac
  dump="$EVAL_DIR/$name.dump"
  [ -f "$dump" ] || fail "no such file: $dump - keep it first: bash scripts/eval-world.sh keep $name"
  up
  psql_eval -d postgres -c "DROP DATABASE IF EXISTS \"$database\" WITH (FORCE)"
  psql_eval -d postgres -c "CREATE DATABASE \"$database\" TEMPLATE template0"
  docker exec -i "$CONTAINER" pg_restore -U "$PG_USER" -d "$database" --exit-on-error --single-transaction \
    < "$dump" || fail "pg_restore failed; $database is incomplete"
  ok "restored $name into $database"
}

down() {
  local container
  for container in "$CONTAINER" "$REDIS_CONTAINER"; do
    ! exists "$container" || docker rm --force --volumes "$container" > /dev/null
  done
  ok "removed $CONTAINER and $REDIS_CONTAINER; the kept dumps in $EVAL_DIR are untouched"
}

case "${1:-}" in
  up)
    up
    ok "$CONTAINER is ready on 127.0.0.1:$PORT, $REDIS_CONTAINER on 127.0.0.1:$REDIS_PORT"
    ;;
  keep)
    [ $# -eq 2 ] || fail "usage: eval-world.sh keep <dump name>"
    keep "$2"
    ;;
  restore)
    [ $# -eq 3 ] || fail "usage: eval-world.sh restore <dump name> <database>"
    restore "$2" "$3"
    ;;
  down) down ;;
  -h | --help | "")
    sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *) fail "unknown command: $1 (try --help)" ;;
esac
