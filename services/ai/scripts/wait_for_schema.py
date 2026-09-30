"""Wait until the database schema is at this image's migration head.

    python scripts/wait_for_schema.py [--timeout SECONDS] [--interval SECONDS]

Run as a Kubernetes init container in front of anything that reads the schema:
the corpus and universe loader Jobs, and the services. See
`app/schema_revision.py` for why a check replaces compose's `depends_on`.

Exits 0 as soon as the schema is current. Exits 1 after `--timeout` with the
last state it saw, so a pod stuck in `Init` says why in `kubectl logs`. An
unreachable database is not an error here - during a fresh deploy Postgres is
often still starting - it is one more reason to wait.
"""

from __future__ import annotations

import argparse
import sys
import time

from sqlalchemy.exc import OperationalError

from app.db import get_engine
from app.schema_revision import current_heads, describe, expected_heads, is_current


def main() -> int:
    parser = argparse.ArgumentParser(description="Wait for the schema to reach this image's head.")
    parser.add_argument("--timeout", type=float, default=600.0)
    parser.add_argument("--interval", type=float, default=3.0)
    args = parser.parse_args()

    expected = expected_heads()
    engine = get_engine()
    deadline = time.monotonic() + args.timeout
    last = ""
    while True:
        try:
            with engine.connect() as connection:
                current = current_heads(connection)
            if is_current(current, expected):
                print(f"schema is current: {', '.join(sorted(expected))}", flush=True)
                return 0
            state = describe(current, expected)
        except OperationalError as error:
            state = f"database not reachable yet ({type(error.orig).__name__})"
        if state != last:
            print(f"waiting: {state}", flush=True)
            last = state
        if time.monotonic() >= deadline:
            print(f"gave up after {args.timeout:.0f}s: {state}", file=sys.stderr, flush=True)
            return 1
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
