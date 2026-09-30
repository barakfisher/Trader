#!/usr/bin/env bash
# =============================================================================
# build-images.sh - build the three production images, tagged by commit.
#
# An image is a frozen filesystem plus the command to run in it: everything a
# service needs, packed so that it runs the same on this Mac, in CI and in a
# Kubernetes cluster. docker compose builds its own development images; these
# are the ones a deployment runs:
#
#   traders/ai-service:<tag>     the FastAPI service (also runs migrations and
#                                the corpus/universe loaders - same image,
#                                different command)
#   traders/orchestrator:<tag>   the Hono API, scheduler-free in a cluster
#   traders/web:<tag>            the built bundle, served by nginx, which also
#                                forwards /api/* to the orchestrator
#
# The tag is the short commit hash, so a running pod can always be traced to
# the exact source it came from. Uncommitted changes add "-dirty-<hash>": such
# an image is not reproducible from any commit, and the tag says so rather than
# borrowing a hash that does not describe it; the second hash changes with the
# edits, so a redeploy picks them up (image_tag in lib/dev-common.sh). Set
# IMAGE_TAG to override.
#
# Builds from the checkout this script lives in - a worktree builds its own
# code, unlike docker compose, whose context is fixed to the main checkout.
#
# Usage:
#   bash scripts/build-images.sh            # build all three
#   IMAGE_TAG=dev bash scripts/build-images.sh
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/dev-common.sh
source "$REPO_ROOT/scripts/lib/dev-common.sh"

require_command docker "Docker Desktop: https://www.docker.com/products/docker-desktop/"
docker info > /dev/null 2>&1 || fail "Docker is installed but not running. Start Docker Desktop and try again."

IMAGE_TAG="${IMAGE_TAG:-$(image_tag)}"

build() {
  local name="$1" dockerfile="$2"
  shift 2
  say "Building traders/$name:$IMAGE_TAG"
  docker build \
    --file "$REPO_ROOT/infra/docker/$dockerfile" \
    --tag "traders/$name:$IMAGE_TAG" \
    "$@" \
    "$REPO_ROOT"
}

build ai-service Dockerfile.ai
build orchestrator Dockerfile.orchestrator
build web Dockerfile.web --target prod

ok "built traders/{ai-service,orchestrator,web}:$IMAGE_TAG"
