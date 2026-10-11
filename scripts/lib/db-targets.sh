# =============================================================================
# Reaching each environment's Postgres - kind's or compose's - from this Mac.
# Sourced (after dev-common.sh) by lib/backups.sh and db-report.sh.
#
# Every command runs *inside* the Postgres container, as its superuser over the
# local socket: the host needs no Postgres client, pg_dump's version always
# matches the server, and no password is handled. The commands are
# single-quoted by the callers so that $POSTGRES_USER and $POSTGRES_DB expand
# in the container.
#
# Written for bash 3.2, the /bin/bash macOS ships and launchd runs.
# =============================================================================

KIND_CONTEXT=kind-traders
KIND_NAMESPACE=traders

db_targets() { echo "kind compose"; }

require_db_target() {
  case "$1" in
    kind | compose) ;;
    *) fail "unknown target '$1' - expected kind or compose" ;;
  esac
}

# The compose Postgres container, found by its compose labels rather than its
# name, so this works without the repository's .env (which `docker compose`
# would need to parse the file).
compose_postgres_container() {
  docker ps --quiet \
    --filter label=com.docker.compose.project=traders \
    --filter label=com.docker.compose.service=postgres \
    --filter status=running 2> /dev/null | head -n 1
}

# 0 when the target's Postgres is running and reachable from here.
db_target_available() {
  case "$1" in
    kind)
      command -v kubectl > /dev/null 2>&1 || return 1
      [ "$(kubectl --context "$KIND_CONTEXT" -n "$KIND_NAMESPACE" --request-timeout=10s \
        get pod postgres-0 -o jsonpath='{.status.phase}' 2> /dev/null)" = Running ]
      ;;
    compose)
      command -v docker > /dev/null 2>&1 || return 1
      [ -n "$(compose_postgres_container)" ]
      ;;
  esac
}

# db_exec <target> <shell command>, stdin passed through to the container.
db_exec() {
  local target="$1" command="$2"
  case "$target" in
    kind)
      kubectl --context "$KIND_CONTEXT" -n "$KIND_NAMESPACE" exec -i postgres-0 -c postgres -- \
        sh -c "$command"
      ;;
    compose)
      local container
      container="$(compose_postgres_container)"
      [ -n "$container" ] || fail "the compose Postgres container is not running"
      docker exec -i "$container" sh -c "$command"
      ;;
  esac
}

# db_sql <target> <database> <sql>: one statement through psql, unaligned and
# tuples-only, stopping at the first error. The SQL travels on stdin, so no
# quoting is needed for it.
db_sql() {
  local target="$1" database="$2" sql="$3"
  # NOTICEs ("does not exist, skipping") are noise here; warnings still show.
  printf 'SET client_min_messages = warning;\n%s\n' "$sql" | db_exec "$target" \
    "psql -X -q -v ON_ERROR_STOP=1 -At -F '|' -U \"\$POSTGRES_USER\" -d '$database'"
}

# The application database's name, as the container was configured.
db_name() { db_exec "$1" 'printf %s "$POSTGRES_DB"' < /dev/null; }
