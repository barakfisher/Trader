#!/usr/bin/env bash
# End-to-end check against a running stack: log in, import the demo portfolio,
# read back a valued portfolio, trigger the snapshot run, confirm it is
# idempotent, then ask the corpus questions (M3).
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

# --- M3: the corpus, and the questions asked of it ---------------------------
#
# Added because the compose job was being counted as coverage for `/ask` while
# never calling it. A gate that cannot fail for the thing it is cited for is
# worse than no gate, because it occupies the space where a real one would go.
#
# Every assertion below is reachable on the FIXTURE embedder, which is what CI
# runs. That rules out one case on purpose: the `not_in_corpus` refusal cannot
# happen here at all, because the relevance floor abstains when the vector half
# is a placeholder (see app/ask/relevance.py). Asserting it would be asserting
# something that cannot be true in this environment — the failure mode this
# block exists to avoid.

say "a concept question is answered from the corpus, with citations"
curl -fsS -b "$COOKIE_JAR" -X POST "$BASE_URL/ask" \
  -H 'content-type: application/json' -d '{"question":"what is a drawdown"}' \
  | python3 -c '
import json, sys
body = json.load(sys.stdin)
assert body["answered"] is True, f"expected an answer, got {body}"
assert body["citations"], "an answer with no citations is not checkable"
assert body["intent"] == "concept", body["intent"]
# The corpus must actually be ingested for this to pass; an empty corpus would
# answer nothing, which is the state this check is really guarding.
# No quotes inside f-string expressions: that is a SyntaxError before Python
# 3.12, and this runs on whatever python3 the host happens to have.
cites, source = len(body["citations"]), body["answer_source"]
relevance, semantic = body["relevance"], body["vector_is_semantic"]
print(f"  {cites} citations, source={source}, relevance={relevance}, semantic={semantic}")
'

say "a portfolio question is computed, never generated"
curl -fsS -b "$COOKIE_JAR" -X POST "$BASE_URL/ask" \
  -H 'content-type: application/json' -d '{"question":"what is my portfolio worth"}' \
  | python3 -c '
import json, sys
body = json.load(sys.stdin)
assert body["intent"] == "portfolio", body["intent"]
# A model is never asked what a portfolio contains. If this ever reads "llm",
# something has routed money questions through a language model.
assert body["answer_source"] in {"computed", "none"}, body["answer_source"]
text = body["text"]
print("  " + text[:100])
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

say "an empty question is refused before it reaches the AI service"
status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" -X POST "$BASE_URL/ask" \
  -H 'content-type: application/json' -d '{"question":"   "}')
[ "$status" = "400" ] || fail "expected 400 for an empty question, got $status"

# --- M5: topic resolution over the instrument universe -----------------------
#
# The only gate that runs the resolver's SQL: the Python suite has no Postgres.
# It needs a universe with descriptions. CI loads eleven hand-written ones
# (`ingest_universe.py --fixture`); a developer's stack loads the gitignored
# data/universe/descriptions.local.jsonl through the `universe` container.
#
# `unavailable` FAILS here, on purpose. It is a correct answer for an
# installation with no universe, and the AI service's own tests pin that - but
# this check exists to prove the stack can load one, and a check that passes
# whether or not it did would be counted as coverage it does not give.
#
# Every assertion holds on both embedders. On the fixture the resolver abstains
# (similarity order, every candidate `weak`), and "uranium mining" still puts a
# uranium company first because the fixture ranks by shared words.

say "a topic resolves to candidates, each with a quoted reason"
curl -fsS -b "$COOKIE_JAR" -X POST "$BASE_URL/topics/resolve" \
  -H 'content-type: application/json' -H 'origin: http://localhost:5173' \
  -d '{"topic":"uranium mining"}' \
  | python3 -c '
import json, sys
body = json.load(sys.stdin)
state, verdict = body["universe"]["state"], body["verdict"]
assert verdict != "unavailable", (
    f"no searchable universe (state={state}): put descriptions.local.jsonl in "
    "data/universe and restart, or run ingest_universe.py --fixture"
)
assert state in {"ready", "partially_embedded"}, state
assert verdict in {"confident", "weak"}, f"uranium mining resolved to {verdict}"
first = body["interpretations"][0]["candidates"]
assert all(c["rationale"] for c in first), "a candidate with no reason"
uranium = {"CCJ", "NXE", "UEC", "LEU", "URA", "URNM", "DNN", "UUUU", "OKLO", "NLR"}
top = [c["symbol"] for c in first[:5]]
assert uranium & set(top), f"no uranium name in the top five: {top}"
profiles, semantic = body["universe"]["profiles"], body["vector_is_semantic"]
print(f"  {verdict}, {profiles} profiles ({state}), semantic={semantic}: {top}")
'

say "an empty topic is refused before it reaches the AI service"
status=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" -X POST "$BASE_URL/topics/resolve" \
  -H 'content-type: application/json' -H 'origin: http://localhost:5173' -d '{"topic":"  "}')
[ "$status" = "400" ] || fail "expected 400 for an empty topic, got $status"

printf '\nAll smoke checks passed.\n'
