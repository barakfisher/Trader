"""`admin_audit` is append-only against a real Postgres, for the role the app uses.

The application connects as a superuser that owns the table, so a `REVOKE`
would change nothing and a test of one would pass while proving nothing. These
run as that same role: an INSERT and a SELECT work, and UPDATE, DELETE and
TRUNCATE are each refused by a trigger (decision 84).
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import DBAPIError

SEED_ADMIN = "00000000-0000-0000-0000-000000000001"


def _insert(connection: Connection) -> int:
    return connection.execute(
        text(
            "INSERT INTO admin_audit (admin_user_id, action, detail, ip_address) "
            "VALUES (CAST(:admin AS uuid), 'POST /admin/example', '{}'::jsonb, '10.0.0.1') "
            "RETURNING id"
        ),
        {"admin": SEED_ADMIN},
    ).scalar_one()


def _refused(connection: Connection, statement: str, **params: object) -> str:
    """Run `statement` in a savepoint and return Postgres's refusal."""
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as refusal:
        connection.execute(text(statement), params)
    savepoint.rollback()
    return str(refusal.value.orig)


def test_the_app_role_is_a_superuser_so_grants_would_not_protect_it(migrated: Engine) -> None:
    # The premise of the triggers. If this ever turns false, separate roles
    # have arrived and the debt row can go.
    with migrated.connect() as connection:
        superuser = "SELECT rolsuper FROM pg_roles WHERE rolname = current_user"
        assert connection.execute(text(superuser)).scalar()


def test_rows_are_written_and_read(migrated: Engine) -> None:
    with migrated.connect() as connection, connection.begin() as transaction:
        row_id = _insert(connection)
        stored = connection.execute(
            text("SELECT action, host(ip_address) AS ip FROM admin_audit WHERE id = :id"),
            {"id": row_id},
        ).one()
        assert (stored.action, stored.ip) == ("POST /admin/example", "10.0.0.1")
        transaction.rollback()


@pytest.mark.parametrize(
    ("operation", "statement"),
    [
        ("UPDATE", "UPDATE admin_audit SET action = 'rewritten' WHERE id = :id"),
        ("DELETE", "DELETE FROM admin_audit WHERE id = :id"),
        ("TRUNCATE", "TRUNCATE admin_audit"),
    ],
)
def test_every_change_to_a_row_is_refused(migrated: Engine, operation: str, statement: str) -> None:
    with migrated.connect() as connection, connection.begin() as transaction:
        row_id = _insert(connection)
        refusal = _refused(connection, statement, id=row_id)
        assert f"admin_audit is append-only: {operation} refused" in refusal
        assert (
            connection.execute(
                text("SELECT action FROM admin_audit WHERE id = :id"), {"id": row_id}
            ).scalar_one()
            == "POST /admin/example"
        )
        transaction.rollback()


def test_an_admin_who_has_acted_cannot_be_deleted_out_from_under_the_audit(
    migrated: Engine,
) -> None:
    with migrated.connect() as connection, connection.begin() as transaction:
        _insert(connection)
        delete = "DELETE FROM users WHERE id = CAST(:id AS uuid)"
        refusal = _refused(connection, delete, id=SEED_ADMIN)
        assert "admin_audit" in refusal
        transaction.rollback()
