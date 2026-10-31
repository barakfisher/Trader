#!/usr/bin/env bash
# =============================================================================
# app-version.sh - print the version the header shows (D351).
#
#   bash scripts/app-version.sh      # 26.10.31+0cad4d6, or 26.10.31+0cad4d6-dirty
#
# The date is HEAD's commit date in UTC (YY.MM.DD), so the same commit prints
# the same version on the Mac and on the server; the hash is what tells two
# commits of one day apart, and what `prod-deploy.sh <commit>` takes. "-dirty"
# marks a checkout with uncommitted changes: what runs is not that commit.
#
# Read by apps/web/vite.config.ts (the dev server and a build on this machine)
# and passed to Docker as the APP_VERSION build argument, because .git is not
# in the build context (.dockerignore). Prints nothing and exits 1 outside a git
# checkout; the header then says the version is unknown.
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

commit="$(git rev-parse --short=7 HEAD 2> /dev/null)" || exit 1
date="$(TZ=UTC git log -1 --date=format-local:%y.%m.%d --format=%cd HEAD)"
dirty=""
[ -z "$(git status --porcelain)" ] || dirty="-dirty"
echo "$date+$commit$dirty"
