#!/usr/bin/env bash
# =============================================================================
# prod-env.sh - write the production host's two secrets files, once (D346).
#
# Run ON THE SERVER, in its checkout, never on the Mac:
#   bash scripts/prod-env.sh <domain> <admin email>
#   e.g. bash scripts/prod-env.sh app.tiklens.com you@example.com
#
# Writes, mode 600, and refuses if either already exists:
#   .env        what every service reads: production settings and generated secrets
#   .env.owner  the database owner's password, read by postgres and migrate only (D300)
#
# Every secret is generated here, on the server, and never printed: it never
# passes through the Mac, a terminal's scrollback or a chat. What only you can
# supply - the OpenRouter key, the Telegram bot's token, the mail provider's
# login - is left empty, and the script lists those keys at the end. Fill them
# with `nano .env` over SSH (docs/RUNBOOK.md section 8).
#
# The values that differ from development, and why:
#   APP_ENV=production       Secure cookies; ALLOWED_ORIGINS must start with https (D345)
#   ALLOWED_ORIGINS          https://<domain> alone (D310)
#   TRUSTED_PROXY_HOPS=2     Caddy, then nginx (infra/caddy/Caddyfile)
#   providers                no `fixture` anywhere: an unavailable price stays
#                            unpriced, never a fixture's invented one (guideline 7)
#   ENABLE_SCHEDULED_SCANS   true: this is the installation whose agents run on a schedule
# =============================================================================
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"

[ $# -eq 2 ] || fail "usage: bash scripts/prod-env.sh <domain> <admin email>"
DOMAIN="$1"
ADMIN="$2"
case "$DOMAIN" in
  *://* | */* | '') fail "give the bare domain, e.g. app.tiklens.com - not a URL" ;;
esac
case "$ADMIN" in
  *@*.*) ;;
  *) fail "the admin email does not look like an address: $ADMIN" ;;
esac

ENV_FILE="$REPO_ROOT/.env"
OWNER_FILE="$REPO_ROOT/.env.owner"
for file in "$ENV_FILE" "$OWNER_FILE"; do
  [ ! -e "$file" ] || fail "$(basename "$file") already exists. It holds the database's passwords: replacing it would lock the services out. Edit it instead."
done
require_command openssl "sudo apt-get install -y openssl"

hex() { openssl rand -hex "$1"; }
# A Fernet key: 32 random bytes, URL-safe base64 (what LLM_KEY_ENCRYPTION_KEYS expects).
fernet_key() { openssl rand -base64 32 | tr '+/' '-_'; }

# set_key <file> <key> <value>: replace the key's line, or append it when the
# template has none. awk rather than sed -i, so a value is never read as a
# pattern. The value reaches awk through its environment, not its arguments:
# any user on the machine can read a process's arguments (/proc/<pid>/cmdline),
# only its owner and root its environment. The rewrite is a file beside .env,
# made under umask 077 and removed even when the script stops halfway.
set_key() {
  local file="$1" key="$2" value="$3" next
  next="$(mktemp "$file.XXXXXX")"
  SET_KEY_VALUE="$value" awk -v key="$key" '
    BEGIN { done = 0; value = ENVIRON["SET_KEY_VALUE"] }
    index($0, key "=") == 1 { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$file" > "$next"
  cat "$next" > "$file"
  rm -f "$next"
}

umask 077
# A run stopped halfway leaves no rewrite of .env behind (set_key's files).
trap 'rm -f -- "$ENV_FILE".??????' EXIT
cp "$REPO_ROOT/.env.example" "$ENV_FILE"

db_password="$(hex 24)"
owner_password="$(hex 24)"

set_key "$ENV_FILE" APP_ENV production
set_key "$ENV_FILE" APP_DOMAIN "$DOMAIN"
set_key "$ENV_FILE" ALLOWED_ORIGINS "https://$DOMAIN"
set_key "$ENV_FILE" WEB_BASE_URL "https://$DOMAIN"
set_key "$ENV_FILE" TRUSTED_PROXY_HOPS 2
set_key "$ENV_FILE" ADMIN_EMAIL "$ADMIN"
set_key "$ENV_FILE" SESSION_SECRET "$(hex 32)"
set_key "$ENV_FILE" INTERNAL_API_KEY "$(hex 24)"
set_key "$ENV_FILE" APP_DB_PASSWORD "$db_password"
set_key "$ENV_FILE" LLM_KEY_ENCRYPTION_KEYS "$(fernet_key)"
set_key "$ENV_FILE" TELEGRAM_SIGNING_SECRET "$(hex 32)"
set_key "$ENV_FILE" TELEGRAM_WEBHOOK_SECRET "$(hex 32)"
set_key "$ENV_FILE" ENABLE_SCHEDULED_SCANS true
# Real providers only (D349 records why Yahoo is acceptable in the private phase).
set_key "$ENV_FILE" MARKET_DATA_PROVIDERS yfinance
set_key "$ENV_FILE" NEWS_PROVIDERS gdelt
set_key "$ENV_FILE" AGENT_NEWS_PROVIDER yahoo
set_key "$ENV_FILE" EMBEDDINGS_PROVIDER openrouter

cat > "$OWNER_FILE" << EOF
POSTGRES_PASSWORD=$owner_password
MIGRATION_DATABASE_URL=postgresql://traders:$owner_password@postgres:5432/traders
EOF

chmod 600 "$ENV_FILE" "$OWNER_FILE"
ok "wrote .env and .env.owner (mode 600) for https://$DOMAIN; no secret was printed"

say "Fill these in .env yourself (nano .env), then deploy:"
for key in OPENROUTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_BOT_USERNAME SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD SMTP_SECURE EMAIL_FROM; do
  printf '     %s\n' "$key"
done
printf '     %sUntil SMTP and EMAIL_FROM are set, sign-up stays closed (no address can be verified, D259).%s\n' "$C_DIM" "$C_RESET"
