"""`legal_acceptances` against a real Postgres (migration 0077, D265).

The record of what a user agreed to: the app's role may add a row and read
them, never change or delete one, and the rows go with the user when the user
row itself goes. The version is a publication date, by a CHECK.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import DBAPIError

SEED_USER = "00000000-0000-0000-0000-000000000001"
VERSION = "2026-11-01"


def _accept(connection: Connection, version: str = VERSION) -> None:
    connection.execute(
        text("INSERT INTO legal_acceptances (user_id, version) VALUES (CAST(:u AS uuid), :v)"),
        {"u": SEED_USER, "v": version},
    )


def _refused(connection: Connection, statement: str) -> str:
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as refusal:
        connection.execute(text(statement), {"u": SEED_USER})
    savepoint.rollback()
    return str(refusal.value.orig)


def test_the_app_role_records_and_reads_an_acceptance(as_app: Engine) -> None:
    with as_app.connect() as connection, connection.begin() as transaction:
        _accept(connection)
        versions = connection.execute(
            text("SELECT version FROM legal_acceptances WHERE user_id = CAST(:u AS uuid)"),
            {"u": SEED_USER},
        ).scalars()
        assert list(versions) == [VERSION]
        transaction.rollback()


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE legal_acceptances SET accepted_at = now() - interval '1 year' "
        "WHERE user_id = CAST(:u AS uuid)",
        "DELETE FROM legal_acceptances WHERE user_id = CAST(:u AS uuid)",
        "TRUNCATE legal_acceptances",
    ],
)
def test_the_app_role_cannot_rewrite_what_someone_agreed_to(as_app: Engine, statement: str) -> None:
    with as_app.connect() as connection, connection.begin() as transaction:
        _accept(connection)
        assert "permission denied" in _refused(connection, statement)
        transaction.rollback()


@pytest.mark.parametrize("version", ["", "v2", "2026-11", "2026-11-01 ", "latest"])
def test_a_version_is_a_publication_date(migrated: Engine, version: str) -> None:
    with migrated.connect() as connection, connection.begin() as transaction:
        savepoint = connection.begin_nested()
        with pytest.raises(DBAPIError, match="check"):
            _accept(connection, version)
        savepoint.rollback()
        transaction.rollback()


def test_the_rows_go_with_the_user(migrated: Engine) -> None:
    with migrated.connect() as connection, connection.begin() as transaction:
        user = connection.execute(
            text("INSERT INTO users (status, llm_cap_micro_usd) VALUES ('pending', 0) RETURNING id")
        ).scalar_one()
        connection.execute(
            text("INSERT INTO legal_acceptances (user_id, version) VALUES (:u, :v)"),
            {"u": user, "v": VERSION},
        )
        connection.execute(text("DELETE FROM users WHERE id = :u"), {"u": user})
        left = connection.execute(
            text("SELECT count(*) FROM legal_acceptances WHERE user_id = :u"), {"u": user}
        ).scalar_one()
        assert left == 0
        transaction.rollback()
