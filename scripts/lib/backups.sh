# =============================================================================
# The database backups: where they live and how old the newest one is.
# Sourced (after dev-common.sh) by db-backup.sh, db-restore.sh and the scripts
# that start or delete a stack. Reaching each environment's Postgres is
# db-targets.sh, which this sources.
#
# Why a script on the Mac rather than a CronJob in the cluster (decision 137):
# a backup must not share a failure domain with what it backs up. kind keeps
# its volumes inside the node container, so a dump written to a cluster volume
# is deleted with the database by `k8s-down.sh`. These dumps live on the Mac.
#
# Written for bash 3.2, the /bin/bash macOS ships and launchd runs: no
# associative arrays, no mapfile, no ${var,,}.
# =============================================================================

#: Outside the repository on purpose: a worktree is deleted when its branch is
#: done, and a dump holds every row of the database, so it must never be one
#: `git add .` away from a commit.
BACKUP_DIR="${TRADERS_BACKUP_DIR:-$HOME/Backups/traders}"

#: The startup scripts warn when the newest backup is older than this. Two
#: days, so one missed night (the Mac was off) is quiet and two are not.
BACKUP_STALE_HOURS=48

#: Kept by db-backup.sh after each dump: the newest BACKUP_KEEP_RECENT, plus
#: the newest of each ISO week for BACKUP_KEEP_WEEKLY_DAYS.
BACKUP_KEEP_RECENT=14
BACKUP_KEEP_WEEKLY_DAYS=56

# shellcheck source=scripts/lib/db-targets.sh
source "$(dirname "${BASH_SOURCE[0]}")/db-targets.sh"

# --- The files -------------------------------------------------------------
#
# traders-<target>-<YYYYMMDDTHHMMSSZ>.dump, with a .counts file beside it: the
# rows each table holds *in the dump*, read from the archive itself.

backup_target_dir() { echo "$BACKUP_DIR/$1"; }

# Newest first. Prints nothing when there are none.
list_backups() {
  local dir
  dir="$(backup_target_dir "$1")"
  [ -d "$dir" ] || return 0
  # The timestamp in the name sorts as it reads, so a reverse name sort is
  # newest first; `ls -t` would trust mtimes a copy may have changed.
  find "$dir" -maxdepth 1 -name "traders-$1-*.dump" -type f 2> /dev/null | sort -r
}

newest_backup() { list_backups "$1" | head -n 1; }

# The YYYYMMDDTHHMMSSZ stamp in a backup's file name.
backup_stamp() {
  local base
  base="$(basename "$1" .dump)"
  echo "${base##*-}"
}

# stamp_format <YYYYMMDDTHHMMSSZ> <date format>: the stamp, read as UTC,
# reformatted. BSD date (macOS) and GNU date (CI) take different flags.
stamp_format() {
  local stamp="$1" format="$2"
  if date -j -u -f '%Y%m%dT%H%M%SZ' "$stamp" "+$format" 2> /dev/null; then
    return 0
  fi
  date -u -d "${stamp:0:8} ${stamp:9:2}:${stamp:11:2}:${stamp:13:2}" "+$format"
}

# Hours since the newest backup of a target, or nothing when there is none.
newest_backup_age_hours() {
  local newest taken
  newest="$(newest_backup "$1")"
  [ -n "$newest" ] || return 0
  taken="$(stamp_format "$(backup_stamp "$newest")" %s)"
  echo $((($(date -u +%s) - taken) / 3600))
}

# Called by the scripts that start a stack, so a schedule that stopped running
# is noticed the next time the stack is started rather than on the day a
# restore is needed. Never fails the caller.
warn_if_backup_stale() {
  local target="$1" age
  age="$(newest_backup_age_hours "$target")"
  if [ -z "$age" ]; then
    warn "no $target database backup exists yet - run: bash scripts/db-backup.sh --target $target"
    warn "and schedule a daily one: bash scripts/backup-schedule.sh install (docs/RUNBOOK.md, section 5)"
  elif [ "$age" -gt "$BACKUP_STALE_HOURS" ]; then
    warn "the newest $target database backup is $age hours old - is the schedule running?"
    warn "check with: bash scripts/backup-schedule.sh status"
  else
    ok "newest $target database backup: $age hours old"
  fi
}
