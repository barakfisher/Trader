#!/usr/bin/env bash
# =============================================================================
# backup-schedule.sh - the daily database backup on this Mac, as a launchd agent.
#
# Usage:
#   bash scripts/backup-schedule.sh install     # daily at 04:00, both databases
#   bash scripts/backup-schedule.sh status      # is it loaded, how did it last end, newest dumps
#   bash scripts/backup-schedule.sh run         # run it now, as launchd would
#   bash scripts/backup-schedule.sh uninstall
#
# Run it from the main checkout, not a worktree: the agent runs
# scripts/db-backup.sh from wherever it was installed, and a worktree is deleted
# when its branch is done. Set TRADERS_BACKUP_DIR before installing to back up
# somewhere other than ~/Backups/traders; the agent keeps the value it saw.
#
# The log is ~/Library/Logs/traders-db-backup.log.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"
# shellcheck source=scripts/lib/backups.sh
source "$REPO_ROOT/scripts/lib/backups.sh"

LABEL=com.traders.db-backup
TEMPLATE="$REPO_ROOT/infra/launchd/$LABEL.plist"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/traders-db-backup.log"
DOMAIN="gui/$(id -u)"

[ "$(uname)" = Darwin ] || fail "launchd is macOS's scheduler; on another system, run scripts/db-backup.sh --target all from cron"

install_agent() {
  # In a worktree, --git-dir is .git/worktrees/<name>, while --git-common-dir is
  # the main checkout's .git.
  if [ "$(cd "$REPO_ROOT" && git rev-parse --absolute-git-dir)" != \
    "$(cd "$REPO_ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd)" ]; then
    fail "this is a worktree, which is deleted when its branch is done - run this from the main checkout"
  fi
  require_command docker
  require_command kubectl

  # The directories that hold docker and kubectl (and what their symlinks point
  # into - Docker Desktop's credential helpers sit beside the real binary), then
  # the system's own.
  local path="" binary dir
  for binary in docker kubectl; do
    for dir in "$(dirname "$(command -v "$binary")")" \
      "$(dirname "$(readlink -f "$(command -v "$binary")" 2> /dev/null || command -v "$binary")")"; do
      case ":$path:" in *":$dir:"*) ;; *) path="${path:+$path:}$dir" ;; esac
    done
  done
  path="$path:/usr/bin:/bin:/usr/sbin:/sbin"

  mkdir -p "$(dirname "$AGENT")" "$(dirname "$LOG")"
  sed -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
    -e "s|__PATH__|$path|g" \
    -e "s|__BACKUP_DIR__|$BACKUP_DIR|g" \
    -e "s|__LOG__|$LOG|g" \
    "$TEMPLATE" > "$AGENT"
  plutil -lint "$AGENT" > /dev/null || fail "the generated $AGENT is not a valid plist"

  # bootout first, so installing again replaces the agent rather than failing.
  launchctl bootout "$DOMAIN/$LABEL" 2> /dev/null || true
  launchctl bootstrap "$DOMAIN" "$AGENT"
  ok "installed: daily at 04:00, backing up into $BACKUP_DIR"
  echo "     run it once now to check it: bash scripts/backup-schedule.sh run"
}

case "${1:-}" in
  install) install_agent ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2> /dev/null || true
    rm -f "$AGENT"
    ok "uninstalled; the dumps in $BACKUP_DIR are kept"
    ;;
  run)
    launchctl print "$DOMAIN/$LABEL" > /dev/null 2>&1 || fail "not installed - run: bash scripts/backup-schedule.sh install"
    launchctl kickstart "$DOMAIN/$LABEL"
    ok "started; follow it with: tail -f $LOG"
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" > /dev/null 2>&1; then
      ok "installed ($AGENT)"
      launchctl print "$DOMAIN/$LABEL" | grep -E '^[[:space:]]*(state|last exit code|runs) =' | sed 's/^[[:space:]]*/     /'
    else
      warn "not installed - run: bash scripts/backup-schedule.sh install"
    fi
    for target in $(backup_targets); do warn_if_backup_stale "$target"; done
    [ ! -f "$LOG" ] || { echo "     last lines of $LOG:"; tail -n 5 "$LOG" | sed 's/^/       /'; }
    ;;
  -h | --help | "")
    sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *) fail "unknown command: $1 (try --help)" ;;
esac
