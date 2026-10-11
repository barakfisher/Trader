#!/usr/bin/env bash
# =============================================================================
# db-report.sh - what the database has been doing, read-only, for choosing indexes
# and retention from evidence (decision 141; database sprint DB3 and DB4).
#
# Usage:
#   bash scripts/db-report.sh --target kind        # or compose
#   bash scripts/db-report.sh --target kind --reset
#       Zero the statistics first (statements, and the table and index counters),
#       so a measurement window starts clean. The only flag that writes.
#
# Sections, each since the statistics were last reset:
#   1. statements by total time - pg_stat_statements (migration 0050), the
#      normalised SQL with its calls, total and mean time, and rows;
#   2. tables by rows read sequentially - a table read whole, often, is where an
#      index may be missing;
#   3. indexes never scanned - candidates to drop, if a full window agrees;
#   4. the largest tables, with dead rows and their last vacuum;
#   5. statements slower than 200 ms from the server's log (the log of the
#      current Postgres container only - a restart starts a new one).
# Row counts are the planner's estimate (pg_class.reltuples, refreshed by ANALYZE),
# not n_live_tup: a reset zeroes the counters, and showed every table empty.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"
# shellcheck source=scripts/lib/db-targets.sh
source "$REPO_ROOT/scripts/lib/db-targets.sh"

TARGET=""
RESET=false
while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      [ $# -ge 2 ] || fail "--target needs a value: kind or compose"
      TARGET="$2"
      shift 2
      ;;
    --reset) RESET=true; shift ;;
    -h | --help)
      sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) fail "unknown option: $1 (try --help)" ;;
  esac
done
[ -n "$TARGET" ] || fail "say which database: --target kind or compose"
require_db_target "$TARGET"
db_target_available "$TARGET" || fail "the $TARGET database is not running"

# A section's query, as an aligned table with its heading.
section() {
  local title="$1" sql="$2"
  echo
  say "$title"
  printf '%s\n' "$sql" | db_exec "$TARGET" \
    'psql -X -q -v ON_ERROR_STOP=1 -P pager=off -P footer=off -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

loaded="$(db_sql "$TARGET" "$(db_name "$TARGET")" \
  "SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements'")"
[ "$loaded" = 1 ] || fail "pg_stat_statements is not installed in the $TARGET database - is migration 0050 applied?"
preloaded="$(db_sql "$TARGET" postgres "SHOW shared_preload_libraries")"
case "$preloaded" in
  *pg_stat_statements*) ;;
  *) fail "the $TARGET server was started without pg_stat_statements preloaded - redeploy it (k8s-up.sh / dev-docker.sh)" ;;
esac

if [ "$RESET" = true ]; then
  db_sql "$TARGET" "$(db_name "$TARGET")" \
    "SELECT pg_stat_statements_reset(); SELECT pg_stat_reset();" > /dev/null
  ok "statistics reset for the $TARGET database at $(date -u +%Y-%m-%dT%H:%MZ) - the window starts now"
  exit 0
fi

section "Window" "
SELECT (SELECT stats_reset FROM pg_stat_statements_info) AS statements_since,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS tables_since,
       now() AS now"

section "1. Statements by total time (top 15)" "
SELECT calls,
       round(total_exec_time::numeric) AS total_ms,
       round(mean_exec_time::numeric, 1) AS mean_ms,
       rows,
       left(regexp_replace(query, '\s+', ' ', 'g'), 110) AS query
  FROM pg_stat_statements
 WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
 ORDER BY total_exec_time DESC
 LIMIT 15"

section "2. Tables by rows read sequentially (top 10)" "
SELECT s.relname AS table_name, seq_scan, seq_tup_read,
       CASE WHEN seq_scan > 0 THEN seq_tup_read / seq_scan END AS rows_per_seq_scan,
       coalesce(idx_scan, 0) AS idx_scan,
       NULLIF(c.reltuples, -1)::bigint AS live_rows
  FROM pg_stat_user_tables s
  JOIN pg_class c ON c.oid = s.relid
 ORDER BY seq_tup_read DESC
 LIMIT 10"

section "3. Indexes never scanned (unique ones excluded: they enforce a rule)" "
SELECT s.relname AS table_name, s.indexrelname AS index_name,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
  FROM pg_stat_user_indexes s
  JOIN pg_index i USING (indexrelid)
 WHERE s.idx_scan = 0 AND NOT i.indisunique
 ORDER BY pg_relation_size(s.indexrelid) DESC"

section "4. Largest tables" "
SELECT s.relname AS table_name,
       pg_size_pretty(pg_total_relation_size(relid)) AS total,
       NULLIF(c.reltuples, -1)::bigint AS live_rows, n_dead_tup AS dead_since_reset,
       greatest(last_vacuum, last_autovacuum) AS last_vacuum
  FROM pg_stat_user_tables s
  JOIN pg_class c ON c.oid = s.relid
 ORDER BY pg_total_relation_size(relid) DESC
 LIMIT 10"

echo
say "5. Statements slower than 200 ms in the server's log"
case "$TARGET" in
  kind) log="$(kubectl --context "$KIND_CONTEXT" -n "$KIND_NAMESPACE" logs postgres-0 -c postgres 2>&1 || true)" ;;
  compose) log="$(docker logs "$(compose_postgres_container)" 2>&1 || true)" ;;
esac
slow="$(printf '%s\n' "$log" | grep -E 'duration: [0-9.]+ ms' || true)"
if [ -z "$slow" ]; then
  echo "none logged since this Postgres container started"
else
  echo "$(printf '%s\n' "$slow" | wc -l | tr -d ' ') logged; the last 10:"
  printf '%s\n' "$slow" | tail -n 10 | cut -c1-220
fi
