"""Erasing a deleted account, against a real Postgres (migration 0076, D264).

The account is the reset test's: a row of every kind a user can own, history
included - fills, cash movements, scans, refused attempts, the seven keys that
had no delete rule. Erased, every table with a `user_id` holds nothing of it,
its reset backup goes with it, the audit keeps its row without the id, and an
identical bystander and the shared instrument are untouched. Then what the
function refuses: an account not closed, one closed but not yet due, the admin.
"""

from __future__ import annotations

from collections.abc import Iterator
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from tests.integration.test_account_reset_sql import INSTRUMENT, _account, _one


def _owned(connection: Connection, user: str) -> dict[str, int]:
    """Rows of `user` in every table with a `user_id`, read from the schema."""
    tables = connection.execute(
        text(
            "SELECT table_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND column_name = 'user_id' ORDER BY 1"
        )
    ).scalars()
    return {
        table: int(
            _one(
                connection, f"SELECT count(*) FROM {table} WHERE user_id = CAST(:u AS uuid)", u=user
            )
        )
        for table in list(tables)
    }


def _close(connection: Connection, user: str, due: str) -> None:
    connection.execute(
        text(
            "UPDATE users SET status = 'closed', deletion_due_at = now() + CAST(:due AS interval) "
            "WHERE id = CAST(:u AS uuid)"
        ),
        {"u": user, "due": due},
    )


def _users(connection: Connection, user: str) -> int:
    return int(_one(connection, "SELECT count(*) FROM users WHERE id = CAST(:u AS uuid)", u=user))


def _erase(connection: Connection, user: str) -> bool:
    return bool(_one(connection, "SELECT erase_account(CAST(:u AS uuid))", u=user))


def _with_reset_and_audit(connection: Connection, account: dict[str, str]) -> None:
    """A reset's backup of the account, and an admin action that named it."""
    connection.execute(
        text("SELECT reset_account(CAST(:u AS uuid), ARRAY['followed_topics'])"),
        {"u": account["user"]},
    )
    connection.execute(
        text(
            "INSERT INTO admin_audit (admin_user_id, action, detail) VALUES "
            "('00000000-0000-0000-0000-0000000000ad', :action, CAST(:detail AS jsonb))"
        ),
        {
            "action": f"POST /admin/users/{account['user']}/disable",
            "detail": f'{{"userId": "{account["user"]}", "query": {{}}}}',
        },
    )


@pytest.fixture()
def connection(as_app: Engine, migrated: Engine) -> Iterator[Connection]:
    """As `traders_app`, which cannot delete history itself - only through the function."""
    with migrated.begin() as owner:
        owner.execute(text("DELETE FROM users WHERE id = '00000000-0000-0000-0000-0000000000ad'"))
        owner.execute(
            text(
                "INSERT INTO users (id, role, status) "
                "VALUES ('00000000-0000-0000-0000-0000000000ad', 'admin', 'active')"
            )
        )
        owner.execute(
            text(
                "INSERT INTO instruments (id, symbol, asset_class) VALUES (:id, 'RSET', 'equity') "
                "ON CONFLICT DO NOTHING"
            ),
            {"id": INSTRUMENT},
        )
    with as_app.connect() as connection, connection.begin() as transaction:
        yield connection
        transaction.rollback()


def test_an_erase_leaves_nothing_of_the_account_and_touches_nobody_else(
    connection: Connection,
) -> None:
    account = _account(connection)
    bystander = _account(connection)
    _with_reset_and_audit(connection, account)
    owned = _owned(connection, account["user"])
    # The seven keys that had no delete rule each hold a row, so each is exercised.
    for table in (
        "agent_cash",
        "agent_scans",
        "cash_movements",
        "fills",
        "proposal_attempts",
        "account_resets",
    ):
        assert owned[table] > 0, f"the account has no {table} row to erase"
    bystander_before = _owned(connection, bystander["user"])
    _close(connection, account["user"], "-1 minute")

    assert _erase(connection, account["user"]) is True

    assert {table: n for table, n in _owned(connection, account["user"]).items() if n} == {}
    assert (
        _one(
            connection, "SELECT count(*) FROM users WHERE id = CAST(:u AS uuid)", u=account["user"]
        )
        == 0
    )
    assert _owned(connection, bystander["user"]) == bystander_before
    assert _one(connection, "SELECT count(*) FROM instruments WHERE id = :i", i=INSTRUMENT) == 1


def test_the_audit_keeps_its_row_with_the_users_id_cleared(connection: Connection) -> None:
    account = _account(connection)
    _with_reset_and_audit(connection, account)
    _close(connection, account["user"], "-1 minute")

    _erase(connection, account["user"])

    row = connection.execute(
        text(
            "SELECT admin_user_id::text AS admin, action, detail FROM admin_audit "
            "WHERE action LIKE 'POST /admin/users/%/disable'"
        )
    ).one()
    assert row.admin == "00000000-0000-0000-0000-0000000000ad"
    assert row.action == "POST /admin/users/erased/disable"
    assert row.detail == {"userId": "erased", "query": {}}


def test_a_conversation_goes_with_the_user(connection: Connection) -> None:
    """`assistant_conversations` is the seventh key; the reset's account holds none."""
    account = _account(connection)
    connection.execute(
        text("INSERT INTO assistant_conversations (user_id, title) VALUES (CAST(:u AS uuid), 'q')"),
        {"u": account["user"]},
    )
    _close(connection, account["user"], "-1 minute")
    assert _erase(connection, account["user"]) is True
    assert (
        _one(
            connection,
            "SELECT count(*) FROM assistant_conversations WHERE user_id = CAST(:u AS uuid)",
            u=account["user"],
        )
        == 0
    )


@pytest.mark.parametrize("due", ["1 minute", "7 days"])
def test_an_account_still_in_its_grace_period_is_not_erased(
    connection: Connection, due: str
) -> None:
    account = _account(connection)
    _close(connection, account["user"], due)
    before = _owned(connection, account["user"])
    assert _erase(connection, account["user"]) is False
    assert _owned(connection, account["user"]) == before


@pytest.mark.parametrize("status", ["active", "disabled"])
def test_an_account_that_did_not_ask_is_never_erased(connection: Connection, status: str) -> None:
    account = _account(connection)
    connection.execute(
        text("UPDATE users SET status = :s WHERE id = CAST(:u AS uuid)"),
        {"u": account["user"], "s": status},
    )
    assert _erase(connection, account["user"]) is False
    assert (
        _one(
            connection, "SELECT count(*) FROM users WHERE id = CAST(:u AS uuid)", u=account["user"]
        )
        == 1
    )


def test_the_admin_is_never_erased(connection: Connection) -> None:
    admin = "00000000-0000-0000-0000-0000000000ad"
    connection.execute(
        text(
            "UPDATE users SET status = 'closed', deletion_due_at = now() - interval '1 day' "
            "WHERE id = CAST(:u AS uuid)"
        ),
        {"u": admin},
    )
    assert _erase(connection, admin) is False
    assert _users(connection, admin) == 1
    # Nobody at all: the same "no row" the admin's lookup finds.
    assert _erase(connection, str(uuid4())) is False


def test_a_rejected_request_is_erased(connection: Connection) -> None:
    user = str(uuid4())
    connection.execute(
        text(
            "INSERT INTO users (id, email, status, rejected_at) "
            "VALUES (CAST(:u AS uuid), :e, 'rejected', now() - interval '91 days')"
        ),
        {"u": user, "e": f"{user}@example.test"},
    )
    assert _erase(connection, user) is True
    assert _users(connection, user) == 0


def test_closed_means_a_date_and_a_date_means_closed(connection: Connection) -> None:
    account = _account(connection)
    with (
        pytest.raises(Exception, match="users_closed_has_deletion_date"),
        connection.begin_nested(),
    ):
        connection.execute(
            text("UPDATE users SET status = 'closed' WHERE id = CAST(:u AS uuid)"),
            {"u": account["user"]},
        )
    with (
        pytest.raises(Exception, match="users_closed_has_deletion_date"),
        connection.begin_nested(),
    ):
        connection.execute(
            text("UPDATE users SET deletion_due_at = now() WHERE id = CAST(:u AS uuid)"),
            {"u": account["user"]},
        )
