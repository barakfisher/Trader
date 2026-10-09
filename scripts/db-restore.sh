#!/usr/bin/env bash
# =============================================================================
# db-restore.sh - restore a dump written by db-backup.sh, or prove that one can be.
#
# Usage:
#   bash scripts/db-restore.sh --target kind --drill latest
#       Restore the newest kind dump into a scratch database, check every table
#       holds exactly the rows the dump holds, and drop the scratch database
#       (--keep leaves it, as <db>_drill, to look at). Touches nothing live.
#
#   bash scripts/db-restore.sh --target compose <file.dump> [--yes]
#       Replace the live database with the dump. Asks first unless --yes.
#
# A real restore never destroys anything:
#   1. the dump is restored into <db>_restore, beside the live database, and
#      checked table by table as the drill is - a failure stops here, with the
#      live database untouched;
#   2. only then are the services that write (orchestrator, ai-service) stopped,
#      the live database renamed to <db>_before_<UTC stamp>, the restored one
#      renamed into its place, and the services started again.
# The old database stays until you drop it; the script prints the command.
#
# The dump's schema revision is the one it was taken at. If the code is newer,
# start the stack again (k8s-up.sh / dev-docker.sh), which migrates it forward.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"
# shellcheck source=scripts/lib/backups.sh
source "$REPO_ROOT/scripts/lib/backups.sh"

TARGET=""
DUMP=""
DRILL=false
KEEP=false
YES=false
while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      [ $# -ge 2 ] || fail "--target needs a value: kind or compose"
      TARGET="$2"
      shift 2
      ;;
    --drill) DRILL=true; shift ;;
    --keep) KEEP=true; shift ;;
    --yes) YES=true; shift ;;
    -h | --help)
      sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) fail "unknown option: $1 (try --help)" ;;
    *)
      [ -z "$DUMP" ] || fail "one dump at a time"
      DUMP="$1"
      shift
      ;;
  esac
done
[ -n "$TARGET" ] || fail "say which database: --target kind or compose"
require_backup_target "$TARGET"
[ -n "$DUMP" ] || fail "say which dump: a .dump file, or 'latest'"
if [ "$DUMP" = latest ]; then
  DUMP="$(newest_backup "$TARGET")"
  [ -n "$DUMP" ] || fail "no $TARGET dump in $(backup_target_dir "$TARGET")"
fi
[ -f "$DUMP" ] || fail "no such file: $DUMP"
COUNTS="${DUMP%.dump}.counts"
[ -f "$COUNTS" ] || fail "no $(basename "$COUNTS") beside the dump - it was not written by db-backup.sh, or was not verified"

backup_target_available "$TARGET" || fail "the $TARGET database is not running"
LIVE_DB="$(db_name "$TARGET")"
[ -n "$LIVE_DB" ] || fail "could not read the $TARGET database's name"

# Restore the dump into a new database of the given name, replacing an earlier
# scratch copy. Never the live database: the name is checked, not trusted.
restore_into() {
  local database="$1"
  [ "$database" != "$LIVE_DB" ] || fail "refusing to restore over the live database '$LIVE_DB'"

  # The dump grants rights to the application role, which lives in the server,
  # not in any database - so it exists wherever migrations have run once.
  [ "$(db_sql "$TARGET" postgres "SELECT count(*) FROM pg_roles WHERE rolname = 'traders_app'")" = 1 ] ||
    fail "the role traders_app does not exist on the $TARGET server - start the stack once (its migrations create it), then restore"

  db_sql "$TARGET" postgres "DROP DATABASE IF EXISTS \"$database\" WITH (FORCE)" > /dev/null
  db_sql "$TARGET" postgres "CREATE DATABASE \"$database\" TEMPLATE template0" > /dev/null
  say "Restoring $(basename "$DUMP") into $database"
  db_exec "$TARGET" "pg_restore -U \"\$POSTGRES_USER\" -d '$database' --exit-on-error --single-transaction" \
    < "$DUMP" || fail "pg_restore failed; $database is incomplete and the live database was not touched"
}

# Every table the dump holds must hold exactly as many rows once restored.
verify_counts() {
  local database="$1" sql="" table rows expected actual
  while IFS='|' read -r table rows; do
    [ -z "$sql" ] || sql="$sql UNION ALL "
    sql="${sql}SELECT '$table', count(*) FROM $table"
  done < "$COUNTS"
  expected="$(sort "$COUNTS")"
  actual="$(db_sql "$TARGET" "$database" "$sql" | sort)"
  if [ "$expected" != "$actual" ]; then
    warn "row counts differ (< in the dump, > restored):"
    diff <(echo "$expected") <(echo "$actual") | grep '^[<>]' >&2 || true
    return 1
  fi
  ok "$(wc -l < "$COUNTS" | tr -d ' ') tables, $(awk -F'|' '{ t += $2 } END { print t + 0 }' "$COUNTS") rows - every table matches the dump"
}

revision() { db_sql "$TARGET" "$1" 'SELECT version_num FROM alembic_version' 2> /dev/null || echo unknown; }

if [ "$DRILL" = true ]; then
  DRILL_DB="${LIVE_DB}_drill"
  restore_into "$DRILL_DB"
  if verify_counts "$DRILL_DB"; then result=0; else result=1; fi
  if [ "$KEEP" = true ]; then
    ok "kept $DRILL_DB; drop it with: DROP DATABASE \"$DRILL_DB\""
  else
    db_sql "$TARGET" postgres "DROP DATABASE \"$DRILL_DB\" WITH (FORCE)" > /dev/null
  fi
  [ "$result" -eq 0 ] || fail "the drill failed: $(basename "$DUMP") does not restore to what it holds"
  ok "drill passed: $(basename "$DUMP") restores completely ($TARGET, revision $(revision "$LIVE_DB") live)"
  exit 0
fi

# --- A real restore ----------------------------------------------------------

if [ "$YES" != true ]; then
  [ -t 0 ] || fail "a restore replaces the live $TARGET database; pass --yes to run without a terminal"
  warn "This replaces the live $TARGET database '$LIVE_DB' with $(basename "$DUMP")."
  warn "The current one is kept, renamed, until you drop it."
  printf '   Type "yes" to continue: '
  read -r reply
  [ "$reply" = "yes" ] || fail "aborted"
fi

RESTORE_DB="${LIVE_DB}_restore"
restore_into "$RESTORE_DB"
verify_counts "$RESTORE_DB" || fail "the restored copy is incomplete; the live database was not touched ($RESTORE_DB kept to inspect)"

# The services that write. Stopped so the rename finds no connection and no
# write lands in the old database after the snapshot; started again by the
# EXIT trap, so they come back even if a step below fails.
STOPPED=""
stop_writers() {
  case "$TARGET" in
    kind)
      local deployment
      for deployment in orchestrator ai-service; do
        STOPPED="$STOPPED $deployment=$(kubectl --context "$KIND_CONTEXT" -n "$KIND_NAMESPACE" \
          get "deployment/$deployment" -o jsonpath='{.spec.replicas}')"
      done
      kubectl --context "$KIND_CONTEXT" -n "$KIND_NAMESPACE" scale deployment/orchestrator deployment/ai-service --replicas=0 > /dev/null
      kubectl --context "$KIND_CONTEXT" -n "$KIND_NAMESPACE" wait --for=delete pod \
        -l 'app in (orchestrator,ai-service)' --timeout=180s > /dev/null 2>&1 || true
      ;;
    compose)
      local service container
      for service in orchestrator ai-service; do
        container="$(docker ps --quiet --filter label=com.docker.compose.project=traders \
          --filter "label=com.docker.compose.service=$service" --filter status=running | head -n 1)"
        [ -z "$container" ] || STOPPED="$STOPPED $container"
      done
      # shellcheck disable=SC2086 # a list of container ids
      [ -z "$STOPPED" ] || docker stop $STOPPED > /dev/null
      ;;
  esac
  ok "stopped the services that write"
}
start_writers() {
  [ -n "$STOPPED" ] || return 0
  local entry
  case "$TARGET" in
    kind)
      for entry in $STOPPED; do
        kubectl --context "$KIND_CONTEXT" -n "$KIND_NAMESPACE" scale "deployment/${entry%%=*}" --replicas="${entry#*=}" > /dev/null || true
      done
      ;;
    compose)
      # shellcheck disable=SC2086 # a list of container ids
      docker start $STOPPED > /dev/null || true
      ;;
  esac
  STOPPED=""
  ok "started the services again"
}
trap start_writers EXIT

stop_writers
BEFORE_DB="${LIVE_DB}_before_$(date -u +%Y%m%d_%H%M%S)"
db_sql "$TARGET" postgres "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE datname IN ('$LIVE_DB', '$RESTORE_DB') AND pid <> pg_backend_pid();
  ALTER DATABASE \"$LIVE_DB\" RENAME TO \"$BEFORE_DB\";
  ALTER DATABASE \"$RESTORE_DB\" RENAME TO \"$LIVE_DB\";
  GRANT CONNECT ON DATABASE \"$LIVE_DB\" TO traders_app;" > /dev/null
ok "$LIVE_DB is now the restored dump; the previous one is $BEFORE_DB"
start_writers

if [ "$TARGET" = kind ]; then
  for deployment in orchestrator ai-service; do
    kubectl --context "$KIND_CONTEXT" -n "$KIND_NAMESPACE" rollout status "deployment/$deployment" --timeout=300s
  done
fi

restored="$(revision "$LIVE_DB")"
previous="$(revision "$BEFORE_DB")"
if [ "$restored" != "$previous" ]; then
  warn "the restored schema is at $restored; the database it replaced was at $previous."
  warn "start the stack again so the migrations bring it forward (k8s-up.sh / dev-docker.sh)."
fi
ok "restore complete. When you no longer need the database it replaced, drop it with:"
echo "     DROP DATABASE \"$BEFORE_DB\""
