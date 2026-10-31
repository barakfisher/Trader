#!/usr/bin/env bash
# =============================================================================
# prod-deploy.sh - deploy a commit to the production host, from the Mac (D347).
#
#   bash scripts/prod-deploy.sh                    # what is on origin/main now
#   bash scripts/prod-deploy.sh <commit>           # an earlier main commit: the way back
#   bash scripts/prod-deploy.sh <commit> --force   # a commit not on main (refused without it)
#
# Over SSH (host `traders-prod` from ~/.ssh/config, or $TRADERS_PROD_SSH), in
# the server's checkout (~/traders, or $TRADERS_PROD_DIR):
#   1. fetches and checks out the commit (detached: the server never commits);
#   2. builds the images there and starts the stack
#      (infra/compose/docker-compose.prod.yml) - migrations first, as always;
#   3. waits until https://<APP_DOMAIN> answers through Caddy, and the API's
#      /readyz does too, and checks the security headers from outside.
#
# The images are built on the server, from git (D347): no registry, nothing
# pushed anywhere. A deploy takes a few minutes, mostly the build.
#
# First time on a new server: docs/RUNBOOK.md section 8 (clone, prod-env.sh,
# fill the keys, the admin's password).
# =============================================================================
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"

HOST="${TRADERS_PROD_SSH:-traders-prod}"
REMOTE_DIR="${TRADERS_PROD_DIR:-traders}"
REF="${1:-origin/main}"
FORCE="${2:-}"
COMPOSE_FILE="infra/compose/docker-compose.prod.yml"
[ -z "$FORCE" ] || [ "$FORCE" = --force ] || fail "the second argument may only be --force"
# A ref crosses SSH as text the server's shell reads again, so only the
# characters a branch, tag or hash is made of are let through.
case "$REF" in
  *[!A-Za-z0-9._/-]* | -*) fail "not a commit, branch or tag: $REF" ;;
esac
case "$REMOTE_DIR" in
  *[!A-Za-z0-9._/-]* | -*) fail "TRADERS_PROD_DIR may hold letters, digits, . _ / - only" ;;
esac

require_command ssh "it ships with macOS"
require_command curl "it ships with macOS"

remote() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$@"; }

say "Checking $HOST"
remote true || fail "cannot SSH to $HOST (ssh $HOST). docs/RUNBOOK.md section 8 sets the key up."

# Everything that runs there, in one script on stdin. Its arguments are
# re-read by the server's shell, so they were checked above and are quoted here.
remote "bash -s -- $(printf '%q ' "$REMOTE_DIR" "$REF" "$COMPOSE_FILE" "${FORCE:-no-force}")" << 'REMOTE'
set -euo pipefail
dir="$1" ref="$2" compose_file="$3" force="$4"
cd "$HOME/$dir" 2> /dev/null || { echo "ERROR no checkout at ~/$dir (docs/RUNBOOK.md section 8)" >&2; exit 1; }
for file in .env .env.owner; do
  [ -f "$file" ] || { echo "ERROR ~/$dir/$file is missing: run scripts/prod-env.sh there first" >&2; exit 1; }
done
git fetch --quiet --prune origin
commit="$(git rev-parse --verify --quiet "$ref^{commit}")" || { echo "ERROR no commit '$ref' on the server" >&2; exit 1; }
# Only what reached main - reviewed and merged - unless asked for by name. A
# pushed branch or tag nobody reviewed would otherwise deploy as easily.
if ! git merge-base --is-ancestor "$commit" origin/main && [ "$force" != --force ]; then
  echo "ERROR $commit is not on origin/main; add --force to deploy it anyway" >&2
  exit 1
fi
git checkout --quiet --detach "$commit"
# The header's version (D351), passed to the web build by compose. A commit from
# before the script existed has none, and its header says the version is unknown.
APP_VERSION="$(bash scripts/app-version.sh 2> /dev/null || true)"
export APP_VERSION
echo "  .. deploying $commit (${APP_VERSION:-no version}) $(git log -1 --format='%s')"

compose=(docker compose -f "$compose_file" --env-file .env)
up_status=0
"${compose[@]}" up -d --build --remove-orphans --quiet-pull > /tmp/traders-deploy.log 2>&1 || up_status=$?
grep -vE '^ *#|^[[:space:]]*$' /tmp/traders-deploy.log | tail -n 20 || true

# migrate is a one-shot; when it fails, `up` fails too, and its log says why.
status="$("${compose[@]}" ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' migrate)"
if [ "$status" != "migrate exited 0" ]; then
  echo "ERROR migrate did not finish cleanly: ${status:-not started}" >&2
  "${compose[@]}" logs --tail 40 migrate >&2 || true
  exit 1
fi
[ "$up_status" -eq 0 ] || { echo "ERROR docker compose up failed (exit $up_status); the lines above say where" >&2; exit 1; }
"${compose[@]}" ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
REMOTE

DOMAIN="$(remote "grep -m 1 '^APP_DOMAIN=' $(printf '%q' "$REMOTE_DIR")/.env | cut -d= -f2-")"
case "$DOMAIN" in
  '' | *[!A-Za-z0-9.-]*) fail "APP_DOMAIN in the server's .env is missing or not a domain" ;;
esac
[ -n "$DOMAIN" ] || fail "APP_DOMAIN is not set in the server's .env"

wait_for_http "https://$DOMAIN/" 180 "https://$DOMAIN (Caddy and the certificate)"
wait_for_http "https://$DOMAIN/api/readyz" 120 "the API"

say "Security headers, from outside"
headers="$(curl -sI "https://$DOMAIN/")"
for header in content-security-policy strict-transport-security x-content-type-options x-frame-options; do
  printf '%s\n' "$headers" | grep -qi "^$header:" || fail "https://$DOMAIN/ is missing the $header header"
done
ok "the page carries its security headers"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://$DOMAIN/api/auth/logout")" = 403 ] ||
  fail "a write with no Origin was not refused (expected 403)"
ok "a write with no Origin is refused"
for path in /api/internal/runs /api/internal /api//internal/runs /api/%69nternal/runs; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "https://$DOMAIN$path")"
  case "$code" in
    404) ;;
    *) fail "$path answered $code from outside (expected 404)" ;;
  esac
done
ok "/api/internal/* is not reachable from outside, however it is spelled"

say "Deployed: https://$DOMAIN"
