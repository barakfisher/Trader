#!/usr/bin/env bash
# =============================================================================
# ingest-corpus-hook.sh - re-ingest the corpus after a document is edited.
#
# Wired to a PostToolUse hook in .claude/settings.json so that editing or adding
# a file under data/corpus/ leaves the database in step with the files. Without
# it the two drift silently: the markdown says one thing, the chips serve
# another, and nothing anywhere reports a disagreement.
#
# It reads the hook payload on stdin and does nothing at all unless the edited
# path is a corpus document, so it is cheap on every other edit.
#
# THIS NEVER FAILS THE EDIT. A developer with no database running must still be
# able to write documents; the ingester simply reports that it could not reach
# one. Re-running it later is free - unchanged documents are compared, not
# rewritten - so a skipped run costs nothing but a later `bash
# scripts/ingest-corpus-hook.sh` or a stack restart.
#
# Usage (normally invoked by the hook, not by hand):
#   echo '{"tool_input":{"file_path":"data/corpus/concepts/drawdown.md"}}' \
#     | bash scripts/ingest-corpus-hook.sh
# =============================================================================
set -uo pipefail

payload="$(cat)"

file_path="$(printf '%s' "$payload" | jq -r '
  .tool_response.filePath // .tool_input.file_path // .tool_input.notebook_path // empty
')"

# Not a corpus document: stay silent and get out of the way.
case "$file_path" in
  */data/corpus/*) ;;
  *) exit 0 ;;
esac

# The repository this file belongs to, which is not necessarily the main
# checkout: a worktree has its own data/corpus and that is the copy being
# edited.
root="${file_path%%/data/corpus/*}"
[ -d "$root/data/corpus" ] || exit 0

# A worktree has no virtualenv of its own (see .claude/MEMORY.md, "Local
# environment"), so fall back to the main checkout's. `--git-common-dir` points
# at the main .git even from inside a worktree.
python="$root/services/ai/.venv/bin/python"
if [ ! -x "$python" ]; then
  common="$(git -C "$root" rev-parse --git-common-dir 2>/dev/null)" || exit 0
  main_checkout="$(cd "$root" && cd "$(dirname "$common")" && pwd)"
  python="$main_checkout/services/ai/.venv/bin/python"
fi
[ -x "$python" ] || {
  printf '{"systemMessage":"Corpus changed; not ingested (no Python environment found).","suppressOutput":true}\n'
  exit 0
}

# DATABASE_URL in .env names the compose hostname `postgres`, which does not
# resolve on the host. Rebuild it against the published port instead. An
# already-set DATABASE_URL wins, so this is overridable.
if [ -z "${DATABASE_URL:-}" ] && [ -f "$root/.env" ]; then
  # shellcheck disable=SC2046
  eval $(grep -E '^(APP_DB_PASSWORD|POSTGRES_DB|POSTGRES_HOST_PORT)=' "$root/.env" | sed 's/^/export /')
  # As traders_app, like the corpus container (migration 0033).
  export DATABASE_URL="postgresql://traders_app:${APP_DB_PASSWORD:-traders_app}@127.0.0.1:${POSTGRES_HOST_PORT:-5432}/${POSTGRES_DB:-traders}"
fi

output="$(cd "$root/services/ai" && PYTHONPATH="$root/services/ai" CORPUS_DIR="$root/data/corpus" \
  "$python" scripts/ingest_corpus.py 2>&1)"
status=$?

if [ $status -ne 0 ]; then
  # Most often: no database running. Never fail the edit over it.
  summary="Corpus changed but was NOT ingested (exit $status). Run: bash scripts/ingest-corpus-hook.sh"
else
  summary="$(printf '%s' "$output" | tr '\n' ' ' | sed 's/  */ /g')"
fi

jq -cn --arg msg "$summary" '{systemMessage:$msg, suppressOutput:true}'
exit 0
