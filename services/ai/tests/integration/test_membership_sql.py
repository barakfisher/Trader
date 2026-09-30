"""`DatabaseMembership` against a real Postgres: a member, a non-member, and an
installation with no universe, which must answer "unknown" rather than "no"."""

from __future__ import annotations

from unittest.mock import patch

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.universe.membership import DatabaseMembership


def test_membership_is_a_profile_and_an_empty_universe_is_unknown(migrated: Engine) -> None:
    with patch("app.universe.membership.get_engine", return_value=migrated):
        membership = DatabaseMembership()
        with migrated.begin() as connection:
            connection.execute(text("DELETE FROM instrument_profiles"))
            connection.execute(
                text(
                    "INSERT INTO instruments (symbol, asset_class) VALUES ('MBRX', 'equity'), "
                    "('GAPX', 'equity') ON CONFLICT (symbol) DO NOTHING"
                )
            )
        assert membership.contains("MBRX") is None

        with migrated.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO instrument_profiles (instrument_id, description, matching_text, "
                    "source, license, content_hash, size_as_of) "
                    "SELECT id, 'd', 'd', 'test', 'test', 'h', now() FROM instruments "
                    "WHERE symbol = 'MBRX'"
                )
            )
        try:
            assert membership.contains("MBRX") is True
            assert membership.contains("GAPX") is False
        finally:
            with migrated.begin() as connection:
                connection.execute(text("DELETE FROM instruments WHERE symbol IN ('MBRX', 'GAPX')"))
