#!/usr/bin/env bash
# =============================================================================
# check-db-targets.sh - stdin reaches the production container whole.
#
#   bash scripts/check-db-targets.sh
#
# `db_exec prod` first looks up the Postgres container over SSH, then pipes
# its stdin into `docker exec` over a second SSH connection. ssh forwards its
# own stdin to the remote side whether or not the remote command reads it, so
# a lookup that does not take /dev/null reads the bytes meant for the second
# connection. That is how every nightly production backup failed until
# 2026-11-03: the archive piped to `pg_restore` arrived without its start,
# the check rejected it, and the dump was deleted.
#
# A stand-in `ssh` runs here that, like the real one, swallows the stdin it is
# given; the check is that a payload piped into `db_exec prod` comes out
# unchanged. Nothing here needs SSH, Docker or the server.
# =============================================================================
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"
# shellcheck source=scripts/lib/db-targets.sh
source "$REPO_ROOT/scripts/lib/db-targets.sh"

# The remote command is ssh's last argument. A container lookup prints an id
# after reading all of stdin, as the real ssh would forward it; `docker exec`
# hands stdin to the command, here a plain copy.
ssh() {
  local remote="${!#}"
  case "$remote" in
    *"docker ps"*) cat > /dev/null; echo c0ffee ;;
    *"docker exec -i c0ffee"*) cat ;;
    *) fail "unexpected remote command: $remote" ;;
  esac
}

payload="PGDMP and the rest of an archive"
got="$(printf '%s' "$payload" | db_exec prod 'cat')"
[ "$got" = "$payload" ] ||
  fail "db_exec prod lost its stdin: sent '$payload', the container got '$got'"
ok "db_exec prod passes stdin to the container whole"
