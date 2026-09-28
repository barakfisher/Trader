"""Tests that run against a real Postgres, opt-in by `TEST_DATABASE_URL`.

The rest of the suite is hermetic and has no database, by design - and so no
line of SQL in this service had ever been executed by a test. Every SQL bug that
cost real time (a parameter Postgres could not type, `plainto_tsquery` ANDing a
question into nothing, a downgrade that met a CHECK over a live row) passed a
full green suite and failed on the first real query. This directory is the
layer the hermetic suite is deliberately isolated from.

**Opt-in by an environment variable, never by `.env`** (CLAUDE.md convention 3).
Without it every test here is skipped, visibly, and the suite stays runnable on
a bare checkout. CI's `postgres (integration)` job sets it.

**The database is wiped.** These tests drop and recreate the `public` schema, so
the URL must name a database whose name ends in `_ci` or `_test`. Pointing it at
the development database is refused, not trusted.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.engine.url import make_url

SERVICE_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = SERVICE_DIR.parents[1]

#: Database names these tests may wipe.
DISPOSABLE_SUFFIXES = ("_ci", "_test")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if os.environ.get("TEST_DATABASE_URL"):
        return
    # In CI a missing URL would skip everything here and leave the job green
    # having tested nothing - a gate that cannot fail. The job says it needs them.
    if os.environ.get("INTEGRATION_REQUIRED") == "1":
        raise pytest.UsageError("INTEGRATION_REQUIRED=1 but TEST_DATABASE_URL is not set")
    skip = pytest.mark.skip(reason="set TEST_DATABASE_URL to run the Postgres integration tests")
    here = Path(__file__).parent
    for item in items:
        if here in Path(str(item.fspath)).parents:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def database_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL", "")
    name = make_url(url).database or ""
    if not name.endswith(DISPOSABLE_SUFFIXES):
        pytest.fail(
            f"TEST_DATABASE_URL names {name!r}; these tests drop its schema, so the name must "
            f"end in one of {DISPOSABLE_SUFFIXES}"
        )
    return url


@pytest.fixture(scope="session")
def engine(database_url: str) -> Iterator[Engine]:
    engine = create_engine(
        database_url.replace("postgresql://", "postgresql+psycopg://", 1), future=True
    )
    yield engine
    engine.dispose()


def reset_schema(engine: Engine) -> None:
    """An empty database: what CI starts from, and what `upgrade head` builds on.

    Every non-system schema goes, not only `public`: 0008 creates the `mastra`
    schema, and a stale one left by an interrupted run fails the next upgrade.
    """
    with engine.begin() as connection:
        schemas = connection.execute(
            text(
                """
                SELECT schema_name FROM information_schema.schemata
                 WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema'
                """
            )
        ).scalars()
        for schema in list(schemas):
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        connection.execute(text("CREATE SCHEMA public"))


def run_script(database_url: str, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
    """Run a service script as its container does, against the test database.

    A subprocess rather than an import, because the scripts and Alembic's
    `env.py` read settings through a cached engine. `DATABASE_URL` and anything
    in `env` are passed explicitly, and an explicit environment variable wins
    over any `.env` a developer has, so the result does not depend on one.
    `PYTHONPATH` pins this checkout's `app` over an editable install of another.
    """
    return subprocess.run(
        [sys.executable, *args],
        cwd=SERVICE_DIR,
        env={
            **os.environ,
            "DATABASE_URL": database_url,
            "PYTHONPATH": str(SERVICE_DIR),
            **env,
        },
        capture_output=True,
        text=True,
        check=False,
    )


def alembic(database_url: str, *args: str) -> subprocess.CompletedProcess[str]:
    return run_script(database_url, "-m", "alembic", *args)


def current_revision(engine: Engine) -> str | None:
    with engine.connect() as connection:
        exists = connection.execute(text("SELECT to_regclass('alembic_version')")).scalar()
        if exists is None:
            return None
        return connection.execute(text("SELECT version_num FROM alembic_version")).scalar()


@pytest.fixture(scope="module")
def migrated(engine: Engine, database_url: str) -> Engine:
    """An empty database at head, for tests that need the schema and nothing else."""
    reset_schema(engine)
    result = alembic(database_url, "upgrade", "head")
    assert result.returncode == 0, result.stderr
    return engine
