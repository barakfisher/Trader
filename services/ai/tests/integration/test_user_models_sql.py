"""A user's saved models and fallbacks against the real schema (migration 0069, D244, D286)."""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

from app.llm.catalogue import FALLBACK_MODEL
from app.llm.user_models import DatabaseUserModels, ModelResolution

CHOSEN = "acme/model-1"
#: Any active non-admin needs a cap while the retired column's CHECK stands (D279).
RETIRED_CAP = 0


def _user(engine: Engine, role: str = "user") -> str:
    with engine.begin() as connection:
        return connection.execute(
            text(
                "INSERT INTO users (role, status, llm_cap_micro_usd) "
                "VALUES (:role, 'active', :cap) RETURNING id::text"
            ),
            {"role": role, "cap": None if role == "admin" else RETIRED_CAP},
        ).scalar_one()


def _agent(
    engine: Engine, user: str, slug: str, *, model: str | None = None, state="active"
) -> str:
    with engine.begin() as connection:
        return connection.execute(
            text(
                "INSERT INTO agents (user_id, slug, name, budget_minor, model, state) "
                "VALUES (CAST(:u AS uuid), :slug, :slug, 100000, :model, :state) RETURNING id::text"
            ),
            {"u": user, "slug": slug, "model": model, "state": state},
        ).scalar_one()


def _settings(engine: Engine, user: str, explain: str | None, assistant: str | None) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO user_settings (user_id, llm_explain_model, llm_assistant_model) "
                "VALUES (CAST(:u AS uuid), :explain, :assistant)"
            ),
            {"u": user, "explain": explain, "assistant": assistant},
        )


def test_each_scope_reads_its_own_saved_model(migrated: Engine) -> None:
    user = _user(migrated)
    agent = _agent(migrated, user, "a", model=CHOSEN)
    _settings(migrated, user, "acme/explain", "acme/assistant")
    store = DatabaseUserModels(migrated)

    assert store.choice(user, "agent", agent).saved == CHOSEN
    assert store.choice(user, "explain", None).saved == "acme/explain"
    assert store.choice(user, "assistant", None).saved == "acme/assistant"
    assert not store.choice(user, "agent", agent).admin
    # Someone else's agent is not this user's choice.
    other = _agent(migrated, _user(migrated), "b", model="acme/other")
    assert store.choice(user, "agent", other).saved is None


def test_a_user_without_settings_has_chosen_nothing_and_the_admin_is_known(
    migrated: Engine,
) -> None:
    admin = _user(migrated, role="admin")
    store = DatabaseUserModels(migrated)
    try:
        assert store.choice(admin, "explain", None).admin
        assert store.choice(admin, "explain", None).saved is None
        assert store.choice("00000000-0000-0000-0000-000000000000", "explain", None) is None
    finally:
        # The schema is left at head for the orchestrator's suites, one of which
        # counts the admins (`queries.postgres.test.ts`): leave none behind.
        with migrated.begin() as connection:
            connection.execute(text("DELETE FROM users WHERE id = CAST(:u AS uuid)"), {"u": admin})


def test_every_scanning_agent_is_listed_oldest_first(migrated: Engine) -> None:
    user = _user(migrated)
    first = _agent(migrated, user, "a", model=CHOSEN)
    second = _agent(migrated, user, "b")
    _agent(migrated, user, "c", state="archived")
    saved = DatabaseUserModels(migrated).all_for(user)
    assert saved is not None
    assert [(a.agent_id, a.name, a.saved) for a in saved.agents] == [
        (first, "a", CHOSEN),
        (second, "b", None),
    ]
    assert (saved.explain, saved.assistant) == (None, None)


def _fallbacks(engine: Engine, user: str) -> list[tuple[str, str, str]]:
    with engine.connect() as connection:
        return [
            tuple(row)
            for row in connection.execute(
                text(
                    "SELECT f.scope, f.saved_model, a.is_primary::text FROM model_fallbacks f "
                    "JOIN agents a ON a.id = f.agent_id "
                    "WHERE f.user_id = CAST(:u AS uuid) ORDER BY f.scope"
                ),
                {"u": user},
            )
        ]


def test_a_fallback_is_recorded_once_and_names_the_main_portfolio_for_user_scopes(
    migrated: Engine,
) -> None:
    user = _user(migrated)
    agent = _agent(migrated, user, "a", model=CHOSEN)
    store = DatabaseUserModels(migrated)
    resolution = ModelResolution(saved=CHOSEN, effective=FALLBACK_MODEL, fallback=True)

    for _ in range(2):
        store.record_fallback(user, "agent", agent, resolution)
        store.record_fallback(user, "assistant", None, resolution)
    assert _fallbacks(migrated, user) == [
        ("agent", CHOSEN, "false"),
        ("assistant", CHOSEN, "true"),
    ]


def test_a_model_id_no_call_could_send_is_refused(migrated: Engine) -> None:
    user = _user(migrated)
    for bad in ("not-an-id", "~acme/latest", "acme/" + "x" * 200):
        with pytest.raises(IntegrityError):
            _agent(migrated, user, "bad", model=bad)
