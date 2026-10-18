"""Accounts for several users against a real Postgres (migration 0057, M9).

What the migration promises, each shown by the database doing or refusing it: a
user who names no status is pending; a pending user has no agent, and becoming
active gives them exactly one, however many times it happens; an active
non-admin without a spend cap is refused, an admin is not; and one email is one
account whatever its case.
"""

from __future__ import annotations

import importlib.util
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import DBAPIError

VERSIONS = Path(__file__).resolve().parents[2] / "alembic" / "versions"
USER = "00000000-0000-0000-0000-0000000000e1"
OTHER = "00000000-0000-0000-0000-0000000000e2"


def _migration() -> ModuleType:
    """0057 itself, for the defaults it writes (asserted as its constants)."""
    spec = importlib.util.spec_from_file_location("m0057", VERSIONS / "0057_user_accounts.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _refused(connection: Connection, statement: str, **params: object) -> str:
    """Run `statement` in a savepoint and return Postgres's refusal."""
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as refusal:
        connection.execute(text(statement), params)
    savepoint.rollback()
    return str(refusal.value.orig)


def _primaries(connection: Connection, user_id: str) -> int:
    return connection.execute(
        text("SELECT count(*) FROM agents WHERE user_id = CAST(:u AS uuid) AND is_primary"),
        {"u": user_id},
    ).scalar_one()


def _status(connection: Connection, user_id: str) -> str:
    return connection.execute(
        text("SELECT status FROM users WHERE id = CAST(:u AS uuid)"), {"u": user_id}
    ).scalar_one()


@pytest.fixture()
def connection(migrated: Engine) -> Iterator[Connection]:
    """A connection whose writes are rolled back after each test."""
    with migrated.connect() as connection, connection.begin() as transaction:
        yield connection
        transaction.rollback()


def test_a_user_who_names_no_status_is_pending_and_has_no_agent(connection: Connection) -> None:
    connection.execute(
        text("INSERT INTO users (id, email) VALUES (CAST(:u AS uuid), 'new@example.test')"),
        {"u": USER},
    )
    assert _status(connection, USER) == "pending"
    assert _primaries(connection, USER) == 0


def test_activation_gives_exactly_one_primary_however_often_it_happens(
    connection: Connection,
) -> None:
    connection.execute(
        text(
            "INSERT INTO users (id, email, llm_cap_micro_usd) "
            "VALUES (CAST(:u AS uuid), 'new@example.test', 0)"
        ),
        {"u": USER},
    )
    connection.execute(
        text("UPDATE users SET status = 'active' WHERE id = CAST(:u AS uuid)"), {"u": USER}
    )
    assert _primaries(connection, USER) == 1

    # Disabled and re-enabled: the primary is kept, and no second one appears.
    for status in ("disabled", "active", "active"):
        connection.execute(
            text("UPDATE users SET status = :s WHERE id = CAST(:u AS uuid)"),
            {"s": status, "u": USER},
        )
    assert _primaries(connection, USER) == 1


def test_a_user_inserted_active_gets_a_primary(connection: Connection) -> None:
    connection.execute(
        text(
            "INSERT INTO users (id, status, llm_cap_micro_usd) "
            "VALUES (CAST(:u AS uuid), 'active', 0)"
        ),
        {"u": USER},
    )
    assert _primaries(connection, USER) == 1


def test_an_active_user_needs_a_cap_and_an_admin_does_not(connection: Connection) -> None:
    refusal = _refused(
        connection,
        "INSERT INTO users (id, status) VALUES (CAST(:u AS uuid), 'active')",
        u=USER,
    )
    assert "users_active_user_has_cap" in refusal

    connection.execute(
        text("INSERT INTO users (id, role, status) VALUES (CAST(:u AS uuid), 'admin', 'active')"),
        {"u": USER},
    )
    # Demoting the admin without giving a cap is refused too.
    refusal = _refused(
        connection, "UPDATE users SET role = 'user' WHERE id = CAST(:u AS uuid)", u=USER
    )
    assert "users_active_user_has_cap" in refusal


def test_activating_a_pending_user_without_a_cap_is_refused(connection: Connection) -> None:
    connection.execute(
        text("INSERT INTO users (id, email) VALUES (CAST(:u AS uuid), 'new@example.test')"),
        {"u": USER},
    )
    refusal = _refused(
        connection, "UPDATE users SET status = 'active' WHERE id = CAST(:u AS uuid)", u=USER
    )
    assert "users_active_user_has_cap" in refusal
    assert _primaries(connection, USER) == 0


def test_one_email_is_one_account_whatever_its_case(connection: Connection) -> None:
    connection.execute(
        text("INSERT INTO users (id, email) VALUES (CAST(:u AS uuid), 'Dana@Example.test')"),
        {"u": USER},
    )
    refusal = _refused(
        connection,
        "INSERT INTO users (id, email) VALUES (CAST(:u AS uuid), 'dana@example.TEST')",
        u=OTHER,
    )
    assert "users_email_lower_key" in refusal


def test_an_unknown_status_is_refused(connection: Connection) -> None:
    refusal = _refused(
        connection, "INSERT INTO users (id, status) VALUES (CAST(:u AS uuid), 'banned')", u=USER
    )
    assert "users_status_check" in refusal


def test_the_installation_defaults_are_the_migrations(connection: Connection) -> None:
    migration = _migration()
    row = connection.execute(
        text("SELECT default_llm_cap_micro_usd, max_pending_signups FROM installation_settings")
    ).one()
    assert row.default_llm_cap_micro_usd == migration.DEFAULT_LLM_CAP_MICRO_USD
    assert row.max_pending_signups == migration.DEFAULT_MAX_PENDING_SIGNUPS

    refusal = _refused(
        connection,
        "UPDATE installation_settings SET max_pending_signups = :n",
        n=migration.MAX_PENDING_SIGNUPS_CEILING + 1,
    )
    assert "max_pending_signups" in refusal


def test_the_seeded_admin_is_active_and_uncapped(connection: Connection) -> None:
    row = connection.execute(
        text(
            "SELECT status, llm_cap_micro_usd FROM users "
            "WHERE id = '00000000-0000-0000-0000-000000000001'"
        )
    ).one()
    assert row.status == "active"
    assert row.llm_cap_micro_usd is None
