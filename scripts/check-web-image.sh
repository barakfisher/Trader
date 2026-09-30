#!/usr/bin/env bash
# =============================================================================
# check-web-image.sh - prove the production web image serves the page and
# forwards /api/* to a running orchestrator.
#
# Starts the image on a docker network where the name `orchestrator` answers
# (the compose stack's), then checks each promise nginx.conf makes. Every one
# of these failed silently in some version of the config, which is why each is
# a check rather than a comment:
#   - a page address that is also an API route (/holdings/x) gets the page;
#   - /api/* reaches the orchestrator with the prefix removed;
#   - /api/internal/* (the service-to-service routes) is not exposed;
#   - a 1.5 MB upload reaches the orchestrator instead of nginx's 1 MB 413;
#   - the bundle calls /api, not a baked-in localhost:8080.
#
# Usage:
#   bash scripts/check-web-image.sh <image> [network] [host port]
#   bash scripts/check-web-image.sh traders/web:ci traders_default 8090
# =============================================================================
set -euo pipefail

IMAGE="${1:?usage: check-web-image.sh <image> [network] [host port]}"
NETWORK="${2:-traders_default}"
PORT="${3:-8090}"
NAME="web-image-check"
BASE="http://127.0.0.1:$PORT"
SCRATCH="$(mktemp -d)"

cleanup() {
  docker rm -f "$NAME" > /dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

failures=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "  ok   $label"
  else
    echo "  FAIL $label: expected '$expected', got '$actual'"
    failures=$((failures + 1))
  fi
}

docker rm -f "$NAME" > /dev/null 2>&1 || true
docker run -d --name "$NAME" --network "$NETWORK" -p "127.0.0.1:$PORT:80" "$IMAGE" > /dev/null

for _ in $(seq 1 20); do
  curl -fsS -o /dev/null "$BASE/" 2> /dev/null && break
  sleep 0.5
done

check "the page is served" "200 text/html" \
  "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$BASE/")"
check "a page address that is also an API route gets the page" "200 text/html" \
  "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$BASE/holdings/x")"
check "/api/readyz reaches the orchestrator" '"service":"orchestrator"' \
  "$(curl -s "$BASE/api/readyz")"
check "the /api prefix is removed on the way" "no route for GET /nope" \
  "$(curl -s "$BASE/api/nope")"

check "/api/internal/* is not reachable through the web entrance" "404" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/internal/runs")"

head -c 1100000 /dev/zero | tr '\0' 'a' > "$SCRATCH/upload.csv"
check "a file over nginx's default 1 MB reaches the orchestrator" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -F "file=@$SCRATCH/upload.csv" "$BASE/api/imports/preview")"

# Both halves: "no localhost" alone passes on an image with no bundle at all.
check "the bundle calls /api" "yes" \
  "$(docker exec "$NAME" sh -c 'cat /usr/share/nginx/html/assets/*.js 2> /dev/null | grep -q "\"/api\"" && echo yes || echo no')"
check "the bundle has no baked-in localhost API address" "0" \
  "$(docker exec "$NAME" sh -c 'cat /usr/share/nginx/html/assets/*.js 2> /dev/null | grep -c "localhost:8080" || true')"

if [ "$failures" -gt 0 ]; then
  docker logs "$NAME" 2>&1 | tail -20
  echo "$failures check(s) failed"
  exit 1
fi
echo "web image $IMAGE: all checks passed"
