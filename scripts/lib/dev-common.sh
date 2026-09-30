# =============================================================================
# Shared helpers for scripts/dev-docker.sh and scripts/dev-local.sh.
# Sourced, never executed directly.
# =============================================================================

# Colours, but only when writing to a terminal (so logs and CI stay readable).
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_BLUE=$'\033[34m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_BOLD=''; C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''
fi

say()  { printf '%s==>%s %s\n' "$C_BLUE$C_BOLD" "$C_RESET" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s  !!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
fail() { printf '%s ERROR%s %s\n' "$C_RED$C_BOLD" "$C_RESET" "$*" >&2; exit 1; }

require_command() {
  local binary="$1" hint="${2:-}"
  command -v "$binary" > /dev/null 2>&1 || fail "'$binary' is not installed. ${hint}"
}

# Create .env from the template on first run, with real generated secrets, so a
# fresh clone never has to hand-edit a file before anything works.
require_env_file() {
  local env_file="$REPO_ROOT/.env"
  [ -f "$env_file" ] && return 0

  say "No .env found - creating one from .env.example"
  cp "$REPO_ROOT/.env.example" "$env_file"

  local session_secret internal_key passphrase
  session_secret="$(openssl rand -hex 32)"
  internal_key="$(openssl rand -hex 16)"
  passphrase="dev-$(openssl rand -hex 6)"

  # BSD sed (macOS) needs an argument to -i; GNU sed does not.
  local sed_inplace=(-i)
  if sed --version > /dev/null 2>&1; then sed_inplace=(-i); else sed_inplace=(-i ''); fi

  sed "${sed_inplace[@]}" \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=${session_secret}|" \
    -e "s|^INTERNAL_API_KEY=.*|INTERNAL_API_KEY=${internal_key}|" \
    -e "s|^APP_PASSPHRASE=.*|APP_PASSPHRASE=${passphrase}|" \
    "$env_file"

  ok "Created .env with generated secrets."
  printf '     %sYour sign-in passphrase is: %s%s%s\n' "$C_DIM" "$C_BOLD" "$passphrase" "$C_RESET"
  printf '     %s(it is stored in .env, which is git-ignored)%s\n' "$C_DIM" "$C_RESET"
}

# Export every variable from .env into this shell, so both scripts can read the
# ports and the passphrase the user actually configured.
load_env() {
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
}

# Poll a URL until it answers, with a readable countdown instead of a blind sleep.
wait_for_http() {
  local url="$1" attempts="${2:-30}" label="${3:-service}" i
  printf '%s  ..%s waiting for %s' "$C_DIM" "$C_RESET" "$label"
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS --max-time 3 "$url" > /dev/null 2>&1; then
      printf '\r'
      ok "$label is ready"
      return 0
    fi
    printf '.'
    sleep 1
  done
  printf '\n'
  fail "$label did not become ready at $url after ${attempts}s. Check the logs."
}

# Refuse to start if something else already owns a port we need, with a message
# that says what to do about it rather than just failing.
#
# The check binds the exact address the process will bind (IPv4 loopback) rather
# than asking "is anything, anywhere, using this number". That distinction is
# real on macOS: another project may hold [::1]:5174 over IPv6 while
# 127.0.0.1:5174 is perfectly free, and refusing to start would be wrong.
require_free_port() {
  local port="$1" label="$2"
  if python3 - "$port" <<'PY'
import socket, sys
probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    probe.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)   # in use
finally:
    probe.close()
sys.exit(0)       # free
PY
  then
    return 0
  fi

  local owner
  owner="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2> /dev/null | awk 'NR==2 {print $1" (pid "$2")"}')"
  fail "port $port on 127.0.0.1 is already in use${owner:+ by $owner}, and $label needs it.
       Either stop that process, or change the port in .env and try again."
}

print_urls() {
  local web_port="${WEB_HOST_PORT:-5173}"
  local api_port="${ORCHESTRATOR_HOST_PORT:-8080}"
  local ai_port="${AI_SERVICE_HOST_PORT:-8000}"
  echo
  printf '%s  Dashboard   %shttp://127.0.0.1:%s%s\n' "$C_BOLD" "$C_RESET" "$web_port" ""
  printf '%s  API         %shttp://127.0.0.1:%s/readyz\n' "$C_BOLD" "$C_RESET" "$api_port"
  printf '%s  AI service  %shttp://127.0.0.1:%s/docs\n' "$C_BOLD" "$C_RESET" "$ai_port"
  printf '%s  Passphrase  %s%s\n' "$C_BOLD" "$C_RESET" "${APP_PASSPHRASE:-see .env}"
  # macOS resolves "localhost" to IPv6 first, and another project may be
  # listening there. 127.0.0.1 is unambiguous.
  printf '%s              use 127.0.0.1, not localhost%s\n' "$C_DIM" "$C_RESET"
  echo
}

# The tag for images built from this checkout: the short commit hash, plus
# "-dirty-<hash of the uncommitted changes>" when the tree has any. The second
# hash is what makes a redeploy notice an edit: with a bare "-dirty", every
# build from an edited tree got the same tag, Kubernetes saw an unchanged
# Deployment, and the pod kept running the previous image. Same uncommitted
# content, same tag - so an unchanged tree does not roll the pods for nothing.
image_tag() {
  local commit dirty
  commit="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  if [ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
    echo "$commit"
    return
  fi
  dirty="$(
    cd "$REPO_ROOT"
    git diff HEAD
    git ls-files --others --exclude-standard -z | xargs -0 -I{} sh -c 'echo "{}"; cat "{}"'
  )"
  echo "$commit-dirty-$(printf '%s' "$dirty" | shasum | cut -c1-8)"
}
