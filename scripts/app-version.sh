#!/usr/bin/env bash
# =============================================================================
# app-version.sh - print the version the header shows (D351, D352).
#
#   bash scripts/app-version.sh      # 2026-10-31T16:12:41Z+c2a9e55, or ...+c2a9e55-dirty
#
# HEAD's commit time in UTC - for a squash merge on GitHub, the moment it
# landed on main - and its short hash. The header shows the time, as the
# user's own clock reads it (D352); the hash is its tooltip, and what
# `prod-deploy.sh <commit>` takes. UTC here, so the same commit prints the same
# version on the Mac and on the server. "-dirty" marks a checkout with
# uncommitted changes: what runs is not that commit.
#
# Read by apps/web/vite.config.ts (the dev server and a build on this machine)
# and passed to Docker as the APP_VERSION build argument, because .git is not
# in the build context (.dockerignore). Prints nothing and exits 1 outside a git
# checkout; the header then says the version is unknown.
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

commit="$(git rev-parse --short=7 HEAD 2> /dev/null)" || exit 1
committed="$(TZ=UTC git log -1 --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd HEAD)"
dirty=""
[ -z "$(git status --porcelain)" ] || dirty="-dirty"
echo "$committed+$commit$dirty"
