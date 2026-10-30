#!/usr/bin/env bash
# =============================================================================
# check-prod-compose.sh - the production host's stack, checked without a server.
#
#   bash scripts/check-prod-compose.sh
#
# Writes a throwaway pair of secrets files with scripts/prod-env.sh in a
# temporary copy of the files it needs, lets docker compose resolve
# infra/compose/docker-compose.prod.yml against them, and checks what a
# mistake there would quietly undo (D347):
#   - only Caddy publishes ports, so Postgres, Redis and the services stay off
#     the internet;
#   - every app service runs with APP_ENV=production and the https origin;
#   - web is the nginx image (target prod), never the dev server;
#   - no provider is `fixture` (guideline 7: no invented prices or headlines);
#   - every container's log is capped;
#   - nothing joins the host's network or runs privileged (either would get
#     past "only Caddy publishes ports");
#   - the orchestrator trusts exactly two proxy hops (Caddy, then nginx), and
#     ALLOWED_ORIGINS is one https address;
#   - Caddy accepts the Caddyfile (`caddy validate`, in Caddy's own image).
# CI runs it on every PR; nothing here needs Oracle, SSH or the domain.
# =============================================================================
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"
require_command docker "Docker: https://docs.docker.com/get-docker/"
require_command python3 "python3"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/infra/compose" "$work/scripts/lib"
cp -R "$REPO_ROOT/infra/caddy" "$work/infra/"
cp "$REPO_ROOT/infra/compose/docker-compose.prod.yml" "$work/infra/compose/"
cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env.owner.example" "$work/"
cp "$REPO_ROOT/scripts/prod-env.sh" "$work/scripts/"
cp "$REPO_ROOT"/scripts/lib/*.sh "$work/scripts/lib/"

(cd "$work" && bash scripts/prod-env.sh app.example.com admin@example.com > /dev/null)
(cd "$work" && docker compose -f infra/compose/docker-compose.prod.yml --env-file .env config --format json) > "$work/config.json"

python3 - "$work/config.json" << 'PY'
import json
import sys

services = json.load(open(sys.argv[1]))["services"]
problems = []
app = {"migrate", "corpus", "universe", "ai-service", "orchestrator"}

for name, service in services.items():
    if service.get("ports") and name != "caddy":
        problems.append(f"{name} publishes ports; only caddy may")
    if service.get("network_mode") or service.get("privileged") or service.get("cap_add"):
        problems.append(f"{name} uses network_mode, privileged or cap_add")
    if (service.get("logging") or {}).get("options", {}).get("max-size") is None:
        problems.append(f"{name} has no log size cap")
    env = service.get("environment") or {}
    if name in app:
        if env.get("APP_ENV") != "production":
            problems.append(f"{name} does not run with APP_ENV=production")
        if name != "migrate" and not str(env.get("ALLOWED_ORIGINS", "")).startswith("https://"):
            problems.append(f"{name}'s first ALLOWED_ORIGINS entry is not https")
        for key in ("MARKET_DATA_PROVIDERS", "NEWS_PROVIDERS", "AGENT_NEWS_PROVIDER", "EMBEDDINGS_PROVIDER"):
            if "fixture" in str(env.get(key, "")).split(","):
                problems.append(f"{name} uses a fixture provider in {key}")

orchestrator = services["orchestrator"].get("environment") or {}
if str(orchestrator.get("TRUSTED_PROXY_HOPS")) != "2":
    problems.append("the orchestrator must trust exactly 2 proxy hops (Caddy, nginx)")
origins = str(orchestrator.get("ALLOWED_ORIGINS", "")).split(",")
if len(origins) != 1 or not origins[0].startswith("https://"):
    problems.append("ALLOWED_ORIGINS must be the one public https address (D310)")
if sorted(p.get("published") for p in services["caddy"].get("ports", [])) != ["443", "443", "80"]:
    problems.append("caddy must publish 80 and 443 (tcp, and udp for http/3)")
if (services["web"].get("build") or {}).get("target") != "prod":
    problems.append("web must build the nginx image (target prod)")
for name in ("mailpit",):
    if name in services:
        problems.append(f"{name} is a development tool and is not part of production")

if problems:
    print("\n".join(f"  - {p}" for p in problems))
    sys.exit(1)
PY
caddy_image="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["services"]["caddy"]["image"])' "$work/config.json")"
docker run --rm -e APP_DOMAIN=app.example.com \
  -v "$REPO_ROOT/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" "$caddy_image" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > "$work/caddy.log" 2>&1 ||
  { cat "$work/caddy.log" >&2; fail "Caddy rejects infra/caddy/Caddyfile"; }
ok "docker-compose.prod.yml: only Caddy is public, production settings everywhere, no fixtures, logs capped"
ok "infra/caddy/Caddyfile is valid for $caddy_image"
