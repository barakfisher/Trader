"""The agent limit against a real Postgres (0047, rewritten by 0062: D199-D201).

What the trigger promises, each shown by the database refusing or doing it:
only **active** simulated agents count; an agent created paused, a pause, an
archive and an edit that keeps an agent active are never refused; creating
one active, resuming one and restoring one into active are refused at the
limit; restoring one into paused is not; and the admin has no limit. The limit
is read from `installation_settings`, so these tests fill to whatever it is.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import DBAPIError

USER = "00000000-0000-0000-0000-0000000000a1"
ADMIN = "00000000-0000-0000-0000-0000000000a2"
LIMIT_REFUSAL = "agent_limit_reached"


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


def _limit(connection: Connection) -> int:
    return connection.execute(
        text("SELECT max_agents_per_user FROM installation_settings")
    ).scalar_one()


def _insert(connection: Connection, user: str, slug: str, state: str = "active") -> None:
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


def _fill(connection: Connection, user: str) -> int:
    limit = _limit(connection)
    for index in range(limit):
        _insert(connection, user, f"{user[-2:]}-active-{index}")
    return limit


def test_a_paused_agent_does_not_count_and_is_created_at_the_limit(connection: Connection) -> None:
    limit = _fill(connection, USER)
    _insert(connection, USER, "paused-extra", state="paused")
    refusal = _refused(connection, _insert, USER, "one-too-many")
    assert refusal.startswith(f"{LIMIT_REFUSAL}: {limit} of {limit} active agents")


def test_resuming_at_the_limit_is_refused_and_pausing_one_makes_room(
    connection: Connection,
) -> None:
    _fill(connection, USER)
    _insert(connection, USER, "waiting", state="paused")
    assert LIMIT_REFUSAL in _refused(connection, _set_state, "waiting", "active")

    _set_state(connection, f"{USER[-2:]}-active-0", "paused")
    _set_state(connection, "waiting", "active")


def test_a_restore_is_refused_into_active_at_the_limit_and_allowed_into_paused(
    connection: Connection,
) -> None:
    _insert(connection, USER, "archived", state="archived")
    _fill(connection, USER)
    assert LIMIT_REFUSAL in _refused(connection, _set_state, "archived", "active")
    _set_state(connection, "archived", "paused")


def test_pausing_archiving_and_editing_are_never_refused_over_the_limit(
    connection: Connection,
) -> None:
    assert _fill(connection, USER) > 1, "the lowered limit below must be a real change"
    # A lowered limit leaves the agents above it active; only the next activation is refused.
    connection.execute(text("UPDATE installation_settings SET max_agents_per_user = 1"))
    first, second = f"{USER[-2:]}-active-0", f"{USER[-2:]}-active-1"
    connection.execute(
        text("UPDATE agents SET name = 'renamed' WHERE slug = :slug"), {"slug": first}
    )
    _set_state(connection, first, "active")
    _set_state(connection, first, "paused")
    _set_state(connection, second, "archived")


def test_the_admin_has_no_limit(connection: Connection) -> None:
    limit = _fill(connection, ADMIN)
    _insert(connection, ADMIN, "beyond-the-limit")
    active = connection.execute(
        text(
            "SELECT count(*) FROM agents "
            "WHERE user_id = CAST(:user AS uuid) AND NOT is_primary AND state = 'active'"
        ),
        {"user": ADMIN},
    ).scalar_one()
    assert active == limit + 1
