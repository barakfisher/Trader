# =============================================================================
# Reaching each environment's Postgres - kind's, compose's or the production
# host's - from this Mac. Sourced (after dev-common.sh) by lib/backups.sh and
# db-report.sh.
#
# `prod` (D347) is reached over SSH, and is a target for backups only:
# db-restore.sh and db-report.sh still accept kind and compose alone
# (require_db_target), so nothing here can restore over production by mistake.
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
# The production host's SSH alias (~/.ssh/config) and its compose project name.
PROD_SSH_HOST="${TRADERS_PROD_SSH:-traders-prod}"
PROD_COMPOSE_PROJECT=traders-prod

# 0 when this Mac knows the production host: an alias ~/.ssh/config resolves
# to an address. A Mac without one is not asked about production at all, so
# its schedule and its start scripts do not warn about a backup it cannot take.
prod_configured() {
  command -v ssh > /dev/null 2>&1 || return 1
  local resolved
  resolved="$(ssh -G "$PROD_SSH_HOST" 2> /dev/null | awk '$1 == "hostname" { print $2; exit }')"
  [ -n "$resolved" ] && [ "$resolved" != "$PROD_SSH_HOST" ]
}

prod_ssh() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$PROD_SSH_HOST" "$@"; }

# The production Postgres container, by its compose labels, on the server.
prod_postgres_container() {
  prod_ssh "docker ps --quiet --filter label=com.docker.compose.project=$PROD_COMPOSE_PROJECT \
    --filter label=com.docker.compose.service=postgres --filter status=running | head -n 1" 2> /dev/null
}

db_targets() {
  if prod_configured; then echo "kind compose prod"; else echo "kind compose"; fi
}

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
    prod)
      prod_configured || return 1
      [ -n "$(prod_postgres_container)" ]
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
    prod)
      local container
      container="$(prod_postgres_container)"
      [ -n "$container" ] || fail "the production Postgres container is not running on $PROD_SSH_HOST"
      # The command crosses two shells (ssh's, then the container's), so it is
      # quoted once more for the remote one; stdin and stdout pass straight through.
      prod_ssh "docker exec -i $container sh -c $(printf '%q' "$command")"
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
