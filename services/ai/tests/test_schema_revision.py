"""The init-container check that stands in for compose's `depends_on` (M7)."""

from __future__ import annotations

from app.schema_revision import describe, expected_heads, is_current


def test_the_shipped_migrations_have_exactly_one_head() -> None:
    # The check compares against this set; test_migration_chain_contract.py
    # owns the one-head rule, this only proves the path to alembic resolves.
    assert len(expected_heads()) == 1


def test_current_only_when_the_database_matches_the_image_exactly() -> None:
    head = frozenset({"0099_new"})
    assert is_current(frozenset({"0099_new"}), head)
    assert not is_current(frozenset(), head)
    assert not is_current(frozenset({"0098_old"}), head)


def test_no_expected_head_is_never_current() -> None:
    # An image that could not read its own migrations must not wave pods through.
    assert not is_current(frozenset(), frozenset())


def test_a_never_migrated_database_is_named_as_such() -> None:
    assert "never migrated" in describe(frozenset(), frozenset({"0099_new"}))


def test_a_database_ahead_of_the_image_is_named_as_unknown_to_it() -> None:
    message = describe(frozenset({"0100_newer"}), frozenset({"0099_new"}))
    assert "does not know" in message
    assert "0100_newer" in message and "0099_new" in message
