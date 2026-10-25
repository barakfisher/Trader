"""Bring the schema to head, then let the application role log in.

    MIGRATION_DATABASE_URL=<the owner's URL> APP_DB_PASSWORD=... python scripts/migrate.py

Run by compose's `migrate` service and the Kubernetes `migrate` Job, as the
role that owns the schema. The owner's URL is `MIGRATION_DATABASE_URL` when it
is set, and wins over `DATABASE_URL`, which names `traders_app` wherever the
services' settings are loaded: the owner's password reaches only this and
Postgres, from a file or Secret of its own (D300). Migration 0033 creates `traders_app` without a
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
from collections.abc import MutableMapping
from pathlib import Path

from psycopg import sql

from app.db import get_engine

#: Must match `APP_ROLE` in migration 0033.
APP_ROLE = "traders_app"

SERVICE_DIR = Path(__file__).resolve().parents[1]


def use_owner_url(environ: MutableMapping[str, str]) -> None:
    """Connect as the owner: `MIGRATION_DATABASE_URL`, when set, becomes `DATABASE_URL`.

    Called before anything reads the settings, and on `os.environ`, so Alembic's
    subprocess inherits it.
    """
    owner_url = environ.get("MIGRATION_DATABASE_URL", "")
    if owner_url:
        environ["DATABASE_URL"] = owner_url


def main() -> int:
    use_owner_url(os.environ)
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
