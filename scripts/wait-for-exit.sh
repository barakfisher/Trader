#!/usr/bin/env bash
# Wait for a one-shot compose service to finish, then fail unless it exited 0.
#
#   bash scripts/wait-for-exit.sh <compose-file> <service> [timeout-seconds]
#
# Exists because the two obvious one-liners are each wrong in a different state,
# and both were measured rather than assumed:
#
#   `ps --format '{{.ExitCode}}'` reports 0 for a container that is STILL
#   RUNNING - so a check that reads it straight away passes whenever it happens
#   to read mid-run. That is how CI's corpus check worked until M3 slice 4, and
#   it never bit only because fixture ingestion finishes fast.
#
#   `docker compose wait` gives the real code for a running container, and for
#   one that has ALREADY exited it prints "No containers for project" and
#   returns 1 - which would fail CI on every run where the service finished
#   first, i.e. usually.
#
# `.State` is the field that tells the two apart, so this polls it until it
# reads `exited` and only then trusts `.ExitCode`. Every branch fails loudly:
# still running at the deadline, never started (empty state), or a non-zero
# exit. None of them can pass by reading too early.
set -euo pipefail

compose_file="$1"
service="$2"
timeout="${3:-240}"

deadline=$((SECONDS + timeout))
state=""
while [ "$SECONDS" -lt "$deadline" ]; do
  state="$(docker compose -f "$compose_file" ps -a "$service" --format '{{.State}}' 2>/dev/null || true)"
  [ "$state" = "exited" ] && break
  sleep 2
done

docker compose -f "$compose_file" logs "$service" || true

if [ "$state" != "exited" ]; then
  echo "$service did not finish within ${timeout}s (state: '${state:-<no container>}')"
  exit 1
fi

code="$(docker compose -f "$compose_file" ps -a "$service" --format '{{.ExitCode}}')"
if [ "$code" != "0" ]; then
  echo "$service exited with code $code"
  exit 1
fi
echo "$service finished cleanly"
