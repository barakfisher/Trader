"""The fixed ceiling on a user's agents against a real Postgres (0063: D202).

What the trigger promises, each shown by the database refusing or doing it: a
user keeps at most `MAX_AGENTS_IN_TOTAL` simulated agents that are not
archived; a create in any state but archived and a restore are refused past
it; a pause, a resume and an archive are not; archiving one makes room; and the
admin has no ceiling. The agents are created paused, so 0062's active limit
never speaks first.
"""

from __future__ import annotations

import importlib.util
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import DBAPIError

USER = "00000000-0000-0000-0000-0000000000b1"
ADMIN = "00000000-0000-0000-0000-0000000000b2"
TOTAL_REFUSAL = "agent_total_reached"

_MIGRATION = Path(__file__).parents[2] / "alembic" / "versions" / "0063_agent_total_ceiling.py"
_spec = importlib.util.spec_from_file_location("agent_total_ceiling", _MIGRATION)
assert _spec is not None and _spec.loader is not None
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
CEILING: int = _module.MAX_AGENTS_IN_TOTAL


@pytest.fixture()
def connection(migrated: Engine) -> Iterator[Connection]:
    """A connection whose writes are rolled back after each test."""
    with migrated.connect() as connection, connection.begin() as transaction:
        connection.execute(
            text(
                "INSERT INTO users (id, status, llm_cap_micro_usd) "
                "VALUES (CAST(:id AS uuid), 'active', 10000000)"
            ),
            {"id": USER},
        )
        connection.execute(
            text(
                "INSERT INTO users (id, role, status) VALUES (CAST(:id AS uuid), 'admin', 'active')"
            ),
            {"id": ADMIN},
        )
        yield connection
        transaction.rollback()


def _insert(connection: Connection, user: str, slug: str, state: str = "paused") -> None:
    connection.execute(
        text(
            "INSERT INTO agents (user_id, slug, name, budget_minor, state) "
            "VALUES (CAST(:user AS uuid), :slug, :slug, 1000, :state)"
        ),
        {"user": user, "slug": slug, "state": state},
    )


def _set_state(connection: Connection, slug: str, state: str) -> None:
    connection.execute(
        text("UPDATE agents SET state = :state WHERE slug = :slug"), {"slug": slug, "state": state}
    )


def _refused(connection: Connection, action: object, *args: object) -> str:
    """Run `action` in a savepoint and return Postgres's refusal."""
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as refusal:
        action(connection, *args)  # type: ignore[operator]
    savepoint.rollback()
    return str(refusal.value.orig)


def _fill(connection: Connection, user: str) -> None:
    for index in range(CEILING):
        _insert(connection, user, f"{user[-2:]}-kept-{index}")


def test_the_ceiling_is_the_shared_constant() -> None:
    types = Path(__file__).parents[4] / "packages" / "shared" / "src" / "types.ts"
    assert f"export const MAX_AGENTS_PER_USER_CEILING = {CEILING};" in types.read_text()


def test_a_create_past_the_ceiling_is_refused_in_any_state(connection: Connection) -> None:
    _fill(connection, USER)
    for state in ("paused", "active"):
        refusal = _refused(connection, _insert, USER, f"one-too-many-{state}", state)
        assert refusal.startswith(f"{TOTAL_REFUSAL}: {CEILING} of {CEILING} agents")
    # An archived agent never counts, so writing one is no new place.
    _insert(connection, USER, "already-archived", state="archived")


def test_a_restore_past_the_ceiling_is_refused_and_archiving_one_makes_room(
    connection: Connection,
) -> None:
    _insert(connection, USER, "archived", state="archived")
    _fill(connection, USER)
    assert TOTAL_REFUSAL in _refused(connection, _set_state, "archived", "paused")
    _set_state(connection, f"{USER[-2:]}-kept-0", "archived")
    _set_state(connection, "archived", "paused")


def test_a_pause_a_resume_and_an_archive_are_never_refused_at_the_ceiling(
    connection: Connection,
) -> None:
    _fill(connection, USER)
    first = f"{USER[-2:]}-kept-0"
    _set_state(connection, first, "active")
    _set_state(connection, first, "paused")
    _set_state(connection, first, "archived")


def test_the_admin_has_no_ceiling(connection: Connection) -> None:
    _fill(connection, ADMIN)
    _insert(connection, ADMIN, "beyond-the-ceiling")
    kept = connection.execute(
        text(
            "SELECT count(*) FROM agents "
            "WHERE user_id = CAST(:user AS uuid) AND NOT is_primary AND state <> 'archived'"
        ),
        {"user": ADMIN},
    ).scalar_one()
    assert kept == CEILING + 1
