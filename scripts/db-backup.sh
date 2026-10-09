#!/usr/bin/env bash
# =============================================================================
# db-backup.sh - dump a Traders database to this Mac, verified, and prune old dumps.
#
# Usage:
#   bash scripts/db-backup.sh --target kind      # the cluster's database
#   bash scripts/db-backup.sh --target compose   # the compose stack's database
#   bash scripts/db-backup.sh --target all       # each one that is running (the schedule's)
#
# Writes $TRADERS_BACKUP_DIR/<target>/traders-<target>-<UTC stamp>.dump
# (default ~/Backups/traders), in pg_dump's custom format, and a .counts file
# beside it. A dump is only given its final name after the whole archive has
# been read back - that read produces the .counts file, the rows each table
# holds in the dump, which db-restore.sh compares a restore against. A dump that
# cannot be read back is deleted and the script fails.
#
# A dump is a consistent snapshot taken while the app keeps running: Postgres
# serves it from one transaction, and nothing waits for it.
#
# Then keeps the newest 14 dumps of the target, plus the newest of each week for
# 8 weeks, and deletes the rest. Decision 137 says why this runs on the Mac.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"
# shellcheck source=scripts/lib/backups.sh
source "$REPO_ROOT/scripts/lib/backups.sh"

TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      [ $# -ge 2 ] || fail "--target needs a value: kind, compose or all"
      TARGET="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) fail "unknown option: $1 (try --help)" ;;
  esac
done
[ -n "$TARGET" ] || fail "say which database: --target kind, compose or all"

# The rows of every table in a custom-format archive, as "schema.table|rows".
# pg_restore turns the archive back into SQL, where each table's data is one
# COPY block ending in a line holding only "\." - and a row is exactly one line,
# because COPY's text format escapes newlines inside values.
count_rows_in_archive() {
  local target="$1" archive="$2"
  db_exec "$target" 'pg_restore --data-only -f -' < "$archive" | awk '
    /^COPY .* FROM stdin;$/ { table = $2; rows = 0; inside = 1; next }
    inside && $0 == "\\." { print table "|" rows; inside = 0; next }
    inside { rows++ }
  '
}

prune() {
  local target="$1" now index=0 kept_weeks="|" file stamp age_days week
  now="$(date -u +%s)"
  # A while-read loop, not `for file in $(...)`: a backup directory under
  # iCloud ("Mobile Documents") has a space in its path.
  while IFS= read -r file; do
    index=$((index + 1))
    stamp="$(backup_stamp "$file")"
    age_days=$(((now - $(stamp_format "$stamp" %s)) / 86400))
    week="$(stamp_format "$stamp" %G-%V)"
    if [ "$index" -le "$BACKUP_KEEP_RECENT" ]; then
      kept_weeks="$kept_weeks$week|"
      continue
    fi
    case "$kept_weeks" in
      *"|$week|"*) ;;
      *)
        if [ "$age_days" -le "$BACKUP_KEEP_WEEKLY_DAYS" ]; then
          kept_weeks="$kept_weeks$week|"
          continue
        fi
        ;;
    esac
    rm -f "$file" "${file%.dump}.counts"
    ok "pruned $(basename "$file")"
  done < <(list_backups "$target")
}

# Files being written, removed if the script stops before naming them final:
# an EXIT trap, because `fail` exits and a function's RETURN trap would not run.
IN_PROGRESS=()
remove_in_progress() { [ ${#IN_PROGRESS[@]} -eq 0 ] || rm -f "${IN_PROGRESS[@]}"; }
trap remove_in_progress EXIT

backup() {
  local target="$1" dir stamp final partial counts tables rows size
  dir="$(backup_target_dir "$target")"
  mkdir -p "$dir"
  chmod 700 "$BACKUP_DIR" "$dir"

  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  final="$dir/traders-$target-$stamp.dump"
  partial="$final.partial"
  counts="${final%.dump}.counts"
  IN_PROGRESS=("$partial" "$counts.partial")

  say "Backing up the $target database"
  db_exec "$target" 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
    < /dev/null > "$partial" || fail "pg_dump failed for $target; no backup was written"

  count_rows_in_archive "$target" "$partial" > "$counts.partial" ||
    fail "the $target dump could not be read back; it was deleted"
  tables="$(wc -l < "$counts.partial" | tr -d ' ')"
  [ "$tables" -gt 0 ] || fail "the $target dump holds no tables; it was deleted"

  mv "$counts.partial" "$counts"
  mv "$partial" "$final"
  IN_PROGRESS=()
  rows="$(awk -F'|' '{ total += $2 } END { print total + 0 }' "$counts")"
  size="$(du -h "$final" | cut -f1 | tr -d ' ')"
  ok "$(basename "$final"): $size, $tables tables, $rows rows"

  prune "$target"
}

umask 077
case "$TARGET" in
  kind | compose)
    backup_target_available "$TARGET" || fail "the $TARGET database is not running, so there is nothing to back up"
    backup "$TARGET"
    ;;
  all)
    # The schedule's form: a stack that is stopped is skipped, not an error -
    # the startup scripts' stale-backup warning is what notices a long gap.
    found=0
    for target in $(backup_targets); do
      if backup_target_available "$target"; then
        found=1
        backup "$target"
      else
        warn "the $target database is not running - skipped"
      fi
    done
    [ "$found" -eq 1 ] || warn "no database was running; nothing was backed up"
    ;;
  *) fail "unknown target '$TARGET' - expected kind, compose or all" ;;
esac
