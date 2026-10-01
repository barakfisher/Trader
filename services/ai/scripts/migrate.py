"""Bring the schema to head, then let the application role log in.

    DATABASE_URL=<the owner's URL> APP_DB_PASSWORD=... python scripts/migrate.py

Run by compose's `migrate` service and the Kubernetes `migrate` Job, as the
role that owns the schema. Migration 0033 creates `traders_app` without a
password, because a migration is committed and a password is a secret; this
sets it from `APP_DB_PASSWORD` after every upgrade. Every run sets it again, so
changing the variable and re-running is how the password is rotated.

Exits 1 when `APP_DB_PASSWORD` is unset rather than leaving the role unable to
log in: every service connects as it, and "the schema migrated" followed by
every service failing authentication is the worse way to learn that.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from psycopg import sql

from app.db import get_engine

#: Must match `APP_ROLE` in migration 0033.
APP_ROLE = "traders_app"

SERVICE_DIR = Path(__file__).resolve().parents[1]


def main() -> int:
    password = os.environ.get("APP_DB_PASSWORD", "")
    if not password:
        print(
            f"APP_DB_PASSWORD is not set: {APP_ROLE}, the role every service connects as, "
            "would have no password to log in with",
            file=sys.stderr,
        )
        return 1

    upgrade = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"], cwd=SERVICE_DIR, check=False
    )
    if upgrade.returncode != 0:
        return upgrade.returncode

    engine = get_engine()
    with engine.begin() as connection:
        # ALTER ROLE takes no bind parameters, so the password is composed as a
        # quoted literal by the driver rather than interpolated by hand.
        statement = sql.SQL("ALTER ROLE {} WITH LOGIN PASSWORD {}").format(
            sql.Identifier(APP_ROLE), sql.Literal(password)
        )
        connection.connection.driver_connection.execute(statement)
    engine.dispose()
    print(f"{APP_ROLE} can log in", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
