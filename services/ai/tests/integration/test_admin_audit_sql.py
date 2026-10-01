"""`admin_audit` is append-only against a real Postgres, for both roles.

The services connect as `traders_app` (migration 0033), which holds `INSERT`
and `SELECT` on the table and nothing else: Postgres refuses its UPDATE, DELETE
and TRUNCATE by privilege, before any trigger runs. The owner, which runs the
migrations, is refused by the triggers instead (decision 84) - the line of
defence that remains for a role grants cannot bind.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.engine.url import make_url
from sqlalchemy.exc import DBAPIError

SEED_ADMIN = "00000000-0000-0000-0000-000000000001"

#: A test password for the app role in a disposable database.
APP_PASSWORD = "traders_app_test"


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


@pytest.fixture(scope="module")
def as_app(migrated: Engine, database_url: str) -> Iterator[Engine]:
    """An engine logged in as `traders_app`, as every service is.

    The password is set here the way `scripts/migrate.py` sets it, since the
    migration creates the role without one.
    """
    with migrated.begin() as connection:
        connection.execute(text(f"ALTER ROLE traders_app WITH LOGIN PASSWORD '{APP_PASSWORD}'"))
    url = make_url(database_url).set(
        drivername="postgresql+psycopg", username="traders_app", password=APP_PASSWORD
    )
    engine = create_engine(url, future=True)
    yield engine
    engine.dispose()


def test_the_app_role_is_not_a_superuser(as_app: Engine) -> None:
    with as_app.connect() as connection:
        role = connection.execute(
            text("SELECT rolname, rolsuper FROM pg_roles WHERE rolname = current_user")
        ).one()
    assert (role.rolname, role.rolsuper) == ("traders_app", False)


def test_the_app_role_writes_and_reads_the_audit(as_app: Engine) -> None:
    with as_app.connect() as connection, connection.begin() as transaction:
        row_id = _insert(connection)
        assert (
            connection.execute(
                text("SELECT action FROM admin_audit WHERE id = :id"), {"id": row_id}
            ).scalar_one()
            == "POST /admin/example"
        )
        transaction.rollback()


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE admin_audit SET action = 'rewritten' WHERE id = :id",
        "DELETE FROM admin_audit WHERE id = :id",
        "TRUNCATE admin_audit",
        # And the triggers that are the owner's only protection.
        "ALTER TABLE admin_audit DISABLE TRIGGER USER",
    ],
)
def test_the_app_role_is_refused_by_privilege(as_app: Engine, statement: str) -> None:
    with as_app.connect() as connection, connection.begin() as transaction:
        row_id = _insert(connection)
        refusal = _refused(connection, statement, id=row_id)
        assert "permission denied" in refusal or "must be owner" in refusal
        transaction.rollback()


@pytest.mark.parametrize(
    "statement",
    [
        "CREATE TABLE intruder (id int)",
        "DROP TABLE holdings",
        "UPDATE alembic_version SET version_num = 'x'",
        "CREATE ROLE intruder",
    ],
)
def test_the_app_role_cannot_change_the_schema(as_app: Engine, statement: str) -> None:
    with as_app.connect() as connection, connection.begin() as transaction:
        refusal = _refused(connection, statement)
        assert "permission denied" in refusal or "must be owner" in refusal
        transaction.rollback()


def test_a_table_created_by_a_later_migration_is_usable_by_the_app(
    migrated: Engine, as_app: Engine
) -> None:
    # The default privileges, which save each migration from granting.
    with migrated.begin() as connection:
        connection.execute(text("CREATE TABLE later_table (id serial PRIMARY KEY, note text)"))
    try:
        with as_app.begin() as connection:
            connection.execute(text("INSERT INTO later_table (note) VALUES ('ok')"))
            assert connection.execute(text("SELECT count(*) FROM later_table")).scalar() == 1
    finally:
        with migrated.begin() as connection:
            connection.execute(text("DROP TABLE later_table"))


def test_the_trigger_tests_below_run_as_the_owner(migrated: Engine) -> None:
    with migrated.connect() as connection:
        superuser = "SELECT rolsuper FROM pg_roles WHERE rolname = current_user"
        assert connection.execute(text(superuser)).scalar(), (
            "the owner tests below assume the role the migrations run as"
        )


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
