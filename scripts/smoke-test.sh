#!/usr/bin/env bash
# End-to-end check of the Milestone 1 vertical slice against a running stack:
# log in, import the demo portfolio, read back a valued portfolio, trigger the
# snapshot run, and confirm the run is idempotent.
#
# Usage: bash scripts/smoke-test.sh [orchestrator_url]
set -euo pipefail

BASE_URL="${1:-http://localhost:8080}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

# shellcheck disable=SC1091
set -a; source "$(dirname "$0")/../.env"; set +a

say() { printf '\n=== %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

say "readiness"
curl -fsS "$BASE_URL/readyz" | tee /dev/stderr | grep -q '"status"' || fail "orchestrator not ready"

say "login"
curl -fsS -c "$COOKIE_JAR" -X POST "$BASE_URL/auth/login" \
  -H 'content-type: application/json' \
  -H 'origin: http://localhost:5173' \
  -d "{\"passphrase\":\"${APP_PASSPHRASE}\"}" > /dev/null || fail "login rejected"

say "login with a wrong passphrase is rejected"
status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/auth/login" \
  -H 'content-type: application/json' -H 'origin: http://localhost:5173' \
  -d '{"passphrase":"definitely-not-it"}')
[ "$status" = "401" ] || fail "expected 401 for a wrong passphrase, got $status"

say "import preview"
preview=$(curl -fsS -b "$COOKIE_JAR" -X POST "$BASE_URL/imports/preview" \
  -H 'origin: http://localhost:5173' \
  -F "file=@$(dirname "$0")/../data/fixtures/demo-portfolio.csv")
preview_id=$(printf '%s' "$preview" | python3 -c 'import json,sys; print(json.load(sys.stdin)["previewId"])')
lines=$(printf '%s' "$preview" | python3 -c 'import json,sys; rows=json.load(sys.stdin)["rows"]; print(json.dumps([r["line"] for r in rows if r["status"]=="ok"]))')
printf 'preview %s, importable lines: %s\n' "$preview_id" "$lines"

say "import commit"
curl -fsS -b "$COOKIE_JAR" -X POST "$BASE_URL/imports/commit" \
  -H 'content-type: application/json' -H 'origin: http://localhost:5173' \
  -d "{\"previewId\":\"$preview_id\",\"mode\":\"replace\",\"lines\":$lines}" | tee /dev/stderr

say "valued portfolio"
portfolio_file="$(mktemp)"
trap 'rm -f "$COOKIE_JAR" "$portfolio_file"' EXIT
curl -fsS -b "$COOKIE_JAR" "$BASE_URL/portfolio" -o "$portfolio_file"
# The checks are passed with -c rather than on stdin: a heredoc would occupy
# stdin and python could not then read the payload.
python3 -c '
import json, sys
data = json.load(open(sys.argv[1]))
summary = data["summary"]
print(json.dumps(summary, indent=2))
assert summary["holdingsCount"] > 0, "no holdings after import"
assert summary["totalValueMinor"] > 0, "portfolio valued at zero"
assert summary["pricedCount"] == summary["holdingsCount"], "some holdings could not be priced"
assert summary["unpricedSymbols"] == [], "unexpected unpriced symbols"
assert [h for h in data["holdings"] if h["valueMinor"] is not None], "no holding carries a value"
assert data["allocationByAssetClass"], "allocation is empty"
weights = sum(s["weightPct"] for s in data["allocationByAssetClass"])
assert abs(weights - 100) < 0.1, "allocation weights do not sum to 100"
fx = [h for h in data["holdings"] if h["costCurrency"] != summary["baseCurrency"]]
assert fx and all(h["valueMinor"] for h in fx), "the non-USD holding was not converted"
' "$portfolio_file"

say "snapshot run"
# A unique run key makes this deterministic: the daily key may already have been
# consumed by the local scheduler or a previous smoke run.
run_key="smoke:$(date +%s):$$"
curl -fsS -X POST "$BASE_URL/internal/runs" \
  -H 'content-type: application/json' -H "x-internal-key: ${INTERNAL_API_KEY}" \
  -d "{\"kind\":\"snapshot\",\"runKey\":\"$run_key\"}" \
  | grep -q '"status":"ok"' || fail "snapshot run did not succeed"

say "snapshot run is idempotent"
curl -fsS -X POST "$BASE_URL/internal/runs" \
  -H 'content-type: application/json' -H "x-internal-key: ${INTERNAL_API_KEY}" \
  -d "{\"kind\":\"snapshot\",\"runKey\":\"$run_key\"}" \
  | grep -q '"status":"skipped"' || fail "second run with the same key was not deduplicated"

say "snapshot is persisted"
curl -fsS -b "$COOKIE_JAR" "$BASE_URL/portfolio/snapshots" \
  | python3 -c '
import json, sys
snapshots = json.load(sys.stdin)["snapshots"]
assert snapshots, "no snapshot was written"
print(json.dumps(snapshots[-1], indent=2))
assert snapshots[-1]["totalMinor"] > 0, "snapshot total is zero"
'

say "internal route rejects a missing key"
status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/internal/runs" \
  -H 'content-type: application/json' -d '{"kind":"snapshot"}')
[ "$status" = "401" ] || fail "expected 401 without the internal key, got $status"

printf '\nAll smoke checks passed.\n'
