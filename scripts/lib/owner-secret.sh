# =============================================================================
# The database owner's password, kept apart from what the services read (D300).
# Sourced, never executed directly; needs scripts/lib/dev-common.sh first.
#
# The owner runs migrations; every service connects as traders_app (0033). So
# the owner's password belongs to two containers only - Postgres, which creates
# the owner with it, and `migrate`, which upgrades the schema as it. Compose
# loads `.env` into every service and every kind pod loads `traders-secrets`,
# so a password kept there reached all of them: code running in any service
# could read the one credential that can change the schema. It now lives in a
# file of its own - `.env.owner` for compose, `overlays/kind/owner.env` for the
# cluster's `traders-owner` Secret - read by those two alone.
#
# A file from before the split is upgraded in place: the owner's lines move to
# the owner file, their values unchanged, so the running Postgres still accepts
# them. Nothing is generated over an existing value.
# =============================================================================

# The owner's keys: Postgres's own variable, and the URL `migrate` connects with.
OWNER_SECRET_KEYS='^(POSTGRES_PASSWORD|MIGRATION_DATABASE_URL)='

# split_owner_secret <app file> <owner file>: move the owner's lines out of the
# app file into the owner file, creating it (mode 600) if needed. A key the owner
# file already holds must hold the same value; a different one is refused rather
# than guessed at, because the wrong one locks `migrate` out of the database.
split_owner_secret() {
  local app_file="$1" owner_file="$2" line key held kept
  grep -Eq "$OWNER_SECRET_KEYS" "$app_file" || return 0
  [ -f "$owner_file" ] || (umask 077 && : > "$owner_file")
  while IFS= read -r line; do
    key="${line%%=*}"
    held="$(grep -m 1 "^$key=" "$owner_file" || true)"
    if [ -z "$held" ]; then
      printf '%s\n' "$line" >> "$owner_file"
    elif [ "$held" != "$line" ]; then
      fail "$key differs between $(basename "$app_file") and $(basename "$owner_file"). The owner file is the one Postgres and migrate read now: delete the line from $(basename "$app_file") once you know which value the database was created with (docs/RUNBOOK.md section 1)."
    fi
  done < <(grep -E "$OWNER_SECRET_KEYS" "$app_file")
  # Rewritten in place, so the app file keeps its own permissions.
  kept="$(mktemp)"
  grep -Ev "$OWNER_SECRET_KEYS" "$app_file" > "$kept" || true
  cat "$kept" > "$app_file"
  rm -f "$kept"
  say "Moved the database owner's password from $(basename "$app_file") to $(basename "$owner_file"), which only Postgres and migrate read"
}

# ensure_migration_url <owner file> <user> <database>: the URL `migrate` connects
# with, from the owner's password, when the file has the password but not the URL
# (compose's `.env` never held one: compose built it from POSTGRES_PASSWORD).
ensure_migration_url() {
  local owner_file="$1" user="$2" database="$3" password
  grep -q '^MIGRATION_DATABASE_URL=' "$owner_file" && return 0
  password="$(grep -m 1 '^POSTGRES_PASSWORD=' "$owner_file" | cut -d= -f2-)"
  [ -n "$password" ] || fail "$(basename "$owner_file") has no POSTGRES_PASSWORD (docs/RUNBOOK.md section 1)"
  printf 'MIGRATION_DATABASE_URL=postgresql://%s:%s@postgres:5432/%s\n' "$user" "$password" "$database" >> "$owner_file"
}
