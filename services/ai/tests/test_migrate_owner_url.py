"""`migrate.py` connects as the owner from a URL only it is given (D300).

The owner's password reaches Postgres and `migrate` alone, as
`MIGRATION_DATABASE_URL`; `DATABASE_URL` names `traders_app` wherever the
services' settings are loaded, compose's shared `.env` included. The run itself
is not exercised here: it sets `traders_app`'s password, which belongs to the
whole Postgres server.
"""

from __future__ import annotations

from scripts.migrate import use_owner_url

APP_URL = "postgresql://traders_app:app@postgres:5432/traders"
OWNER_URL = "postgresql://traders:owner@postgres:5432/traders"


def test_the_owner_url_wins_over_the_app_url() -> None:
    environ = {"DATABASE_URL": APP_URL, "MIGRATION_DATABASE_URL": OWNER_URL}
    use_owner_url(environ)
    assert environ["DATABASE_URL"] == OWNER_URL


def test_without_one_the_database_url_is_left_as_given() -> None:
    unset: dict[str, str] = {"DATABASE_URL": OWNER_URL}
    empty = {"DATABASE_URL": OWNER_URL, "MIGRATION_DATABASE_URL": ""}
    for environ in (unset, empty):
        use_owner_url(environ)
        assert environ["DATABASE_URL"] == OWNER_URL
