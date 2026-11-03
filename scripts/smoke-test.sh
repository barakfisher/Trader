#!/usr/bin/env bash
# End-to-end check against a running stack: log in, import the demo portfolio,
# read back a valued portfolio, trigger the snapshot run, confirm it is
# idempotent, then reach the assistant and the concept corpus.
#
# !! THIS REPLACES EVERY HOLDING IN THE TARGET DATABASE !!
# The import below commits with `mode: "replace"`, so whatever portfolio the
# database held is deleted and the demo portfolio is written in its place. On a
# development stack seeded from the demo file that is a no-op; on a database
# holding a real portfolio, or cost bases edited by hand in the UI, it is not,
# and nothing here asks first. Target weights survive (they are keyed by symbol)
# and no foreign key points at a holding id, so nothing is left dangling - but
# the holdings themselves are gone. Point it at a stack you are willing to reset.
#
# Usage: bash scripts/smoke-test.sh [orchestrator_url]
#
# ADMIN_EMAIL and ADMIN_PASSWORD are the admin's sign-in (D179; set them with
# scripts/admin-password.sh). SMOKE_ENV_FILE names the file holding
# INTERNAL_API_KEY (default: the repository's .env), and SMOKE_ORIGIN the Origin
# the requests claim (default: the compose web app's). Against the kind cluster:
#   ADMIN_EMAIL=... ADMIN_PASSWORD=... SMOKE_ENV_FILE=infra/k8s/overlays/kind/secrets.env \
#   SMOKE_ORIGIN=http://traders.localhost bash scripts/smoke-test.sh http://127.0.0.1:8089
#
# SMOKE_ASSISTANT says what the assistant question may answer. Unset, either
# `no_model` or a reply of the model's (`answer`, `decline`, `clarify`): a local
# stack usually has a model chosen, and one that answers is wired correctly.
# `no_model` requires exactly that outcome; CI sets it, because CI runs no model
# and an answer there would mean one was reachable.
set -euo pipefail

BASE_URL="${1:-http://localhost:8080}"
ORIGIN="${SMOKE_ORIGIN:-http://localhost:5173}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

# The caller's sign-in wins over the env file's: .env carries ADMIN_EMAIL for the
# start scripts, and sourcing it would replace the address the caller set.
caller_email="${ADMIN_EMAIL:-}"
# shellcheck disable=SC1090,SC1091
set -a; source "${SMOKE_ENV_FILE:-$(dirname "$0")/../.env}"; set +a
ADMIN_EMAIL="${caller_email:-${ADMIN_EMAIL:-}}"

say() { printf '\n=== %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

say "readiness"
curl -fsS "$BASE_URL/readyz" | tee /dev/stderr | grep -q '"status"' || fail "orchestrator not ready"

[ -n "${ADMIN_EMAIL:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ] \
  || fail "set ADMIN_EMAIL and ADMIN_PASSWORD - the address and password scripts/admin-password.sh gave the admin"

# The body built by Python, so a password with a quote in it is still JSON.
login_body() {
  python3 -c 'import json,sys; print(json.dumps({"email": sys.argv[1], "password": sys.argv[2]}))' "$1" "$2"
}

say "login"
login_body "$ADMIN_EMAIL" "$ADMIN_PASSWORD" | curl -fsS -c "$COOKIE_JAR" -X POST "$BASE_URL/auth/login" \
  -H 'content-type: application/json' \
  -H "origin: $ORIGIN" \
  --data-binary @- > /dev/null || fail "login rejected"

say "login with a wrong password is rejected"
status=$(login_body "$ADMIN_EMAIL" "definitely-not-it" | curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$BASE_URL/auth/login" -H 'content-type: application/json' -H "origin: $ORIGIN" \
  --data-binary @-)
[ "$status" = "401" ] || fail "expected 401 for a wrong password, got $status"

say "import preview"
preview=$(curl -fsS -b "$COOKIE_JAR" -X POST "$BASE_URL/imports/preview" \
  -H "origin: $ORIGIN" \
  -F "file=@$(dirname "$0")/../data/fixtures/demo-portfolio.csv")
preview_id=$(printf '%s' "$preview" | python3 -c 'import json,sys; print(json.load(sys.stdin)["previewId"])')
lines=$(printf '%s' "$preview" | python3 -c 'import json,sys; rows=json.load(sys.stdin)["rows"]; print(json.dumps([r["line"] for r in rows if r["status"]=="ok"]))')
printf 'preview %s, importable lines: %s\n' "$preview_id" "$lines"

say "import commit"
curl -fsS -b "$COOKIE_JAR" -X POST "$BASE_URL/imports/commit" \
  -H 'content-type: application/json' -H "origin: $ORIGIN" \
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
# A user's run names its user (D161, D238): the signed-in account's, from its session.
user_id=$(curl -fsS -b "$COOKIE_JAR" "$BASE_URL/auth/session" \
  | python3 -c 'import json, sys; print(json.load(sys.stdin)["user"]["id"])') \
  || fail "could not read the signed-in user"
curl -fsS -X POST "$BASE_URL/internal/runs" \
  -H 'content-type: application/json' -H "x-internal-key: ${INTERNAL_API_KEY}" \
  -d "{\"kind\":\"snapshot\",\"userId\":\"$user_id\",\"runKey\":\"$run_key\"}" \
  | grep -q '"status":"ok"' || fail "snapshot run did not succeed"

say "snapshot run is idempotent"
curl -fsS -X POST "$BASE_URL/internal/runs" \
  -H 'content-type: application/json' -H "x-internal-key: ${INTERNAL_API_KEY}" \
  -d "{\"kind\":\"snapshot\",\"userId\":\"$user_id\",\"runKey\":\"$run_key\"}" \
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

# --- M3 and the assistant: the corpus, and a question asked of it ------------
#
# The extractive `/ask` this block used to call was removed with assistant PR 4;
# `/ask` is now the assistant, which has no path without a model (decided
# 2026-10-07). What is checked here is the wiring: a question goes browser ->
# orchestrator -> AI service, is stored, and comes back as a 200. With no model
# (CI) that is the `no_model` outcome, which says what is missing, never an
# error; with a model chosen (a local stack, usually) it is the model's reply.
# Any other outcome - `failed`, a budget or cap reached, an own-key refusal - is
# a stack that cannot answer, and fails. What a real model answers is the
# assistant eval's job (services/ai/scripts/run_assistant_eval.py), which is
# keyed and paid.

say "a question reaches the assistant and is answered, or says it needs a model"
curl -fsS -b "$COOKIE_JAR" -X POST "$BASE_URL/assistant/messages" \
  -H 'content-type: application/json' -H "origin: $ORIGIN" \
  -d '{"message":"what is a drawdown"}' \
  | SMOKE_ASSISTANT="${SMOKE_ASSISTANT:-}" python3 -c '
import json, os, sys
body = json.load(sys.stdin)
outcome = body["outcome"]
if os.environ["SMOKE_ASSISTANT"] == "no_model":
    assert outcome == "no_model", f"expected no_model (SMOKE_ASSISTANT=no_model), got {body}"
else:
    replied = ("answer", "decline", "clarify")
    names = ", ".join(replied)
    assert outcome == "no_model" or outcome in replied, (
        f"expected no_model or a reply ({names}), got {outcome}: {body}"
    )
assert body["conversationId"], "the question must be stored, with a reply or without"
print(f"  {outcome}: " + (body.get("text") or "")[:100])
'

say "a concept chip resolves to its document"
curl -fsS -b "$COOKIE_JAR" "$BASE_URL/concepts/drawdown" \
  | python3 -c '
import json, sys
doc = json.load(sys.stdin)
assert doc["sections"], "the corpus is not ingested"
assert doc["license"], "an unlicensed document must never be served"
title, count, licence = doc["title"], len(doc["sections"]), doc["license"]
print(f"  {title}: {count} sections, {licence}")
'

printf '\nAll smoke checks passed.\n'
