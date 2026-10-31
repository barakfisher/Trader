"""`GET /llm/users/{id}/models`: what an agent with no model of its own runs on (D352).

The resolution itself is `test_user_models.py`'s and the SQL is
`integration/test_user_models_sql.py`'s. What is pinned here is the default the
page shows: the tested model for a user, the Admin page's agent model for the
admin, and an admin's agent with a model of its own resolved as a user's is.
"""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.db import get_engine
from app.llm.catalogue import FALLBACK_MODEL
from app.llm.openrouter_models import ListedModel, ModelList
from app.llm.pricing import DEFAULT_MODEL_PRICES, ModelPrice
from app.llm.user_models import AgentModel, UserModels
from app.main import app
from app.routers import llm as llm_router

INTERNAL_KEY = "test-key"
USER_ID = "11111111-1111-1111-1111-111111111111"
CHOSEN_AGENT = "22222222-2222-2222-2222-222222222222"
PLAIN_AGENT = "33333333-3333-3333-3333-333333333333"
CHOSEN = "acme/chosen"
ADMIN_PICK = "anthropic/claude-sonnet-5.5"


class Listed:
    async def current(self) -> ModelList:
        return ModelList(
            models=(
                ListedModel(
                    id=FALLBACK_MODEL, name="Flash-Lite", price=DEFAULT_MODEL_PRICES[FALLBACK_MODEL]
                ),
                ListedModel(id=CHOSEN, name=CHOSEN, price=ModelPrice(Decimal(1), Decimal(3))),
            ),
            live=True,
        )

    @property
    def prices(self) -> dict[str, ModelPrice]:
        return DEFAULT_MODEL_PRICES


@pytest.fixture
def saved(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    state: dict[str, Any] = {"admin": False}

    class Users:
        def __init__(self, engine: object) -> None: ...

        def all_for(self, user_id: str) -> UserModels:
            return UserModels(
                admin=state["admin"],
                explain=None,
                assistant=None,
                agents=(
                    AgentModel(agent_id=CHOSEN_AGENT, name="chosen", saved=CHOSEN),
                    AgentModel(agent_id=PLAIN_AGENT, name="plain", saved=None),
                ),
            )

    class Choices:
        def __init__(self, engine: object) -> None: ...

        def chosen(self, scope: str) -> str | None:
            return ADMIN_PICK if scope == "agent" else None

    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        internal_api_key=INTERNAL_KEY,
        llm_provider="openrouter",
    )
    monkeypatch.setattr(llm_router, "DatabaseUserModels", Users)
    monkeypatch.setattr(llm_router, "DatabaseModelChoices", Choices)
    monkeypatch.setattr(llm_router, "get_settings", lambda: settings)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_engine] = lambda: object()
    app.state.listed_models = Listed()
    yield state
    app.dependency_overrides.clear()
    del app.state.listed_models


def _get() -> dict[str, Any]:
    response = TestClient(app).get(
        f"/llm/users/{USER_ID}/models", headers={"x-internal-key": INTERNAL_KEY}
    )
    assert response.status_code == 200, response.text
    return response.json()


def _agents(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {agent["agent_id"]: agent for agent in body["agents"]}


def test_a_users_agent_with_no_model_runs_on_the_tested_model(saved: dict[str, Any]) -> None:
    body = _get()
    assert body["agent_default"] == FALLBACK_MODEL
    assert _agents(body)[PLAIN_AGENT]["effective"] == FALLBACK_MODEL


def test_the_admins_agent_with_no_model_runs_on_the_admin_pages_choice(
    saved: dict[str, Any],
) -> None:
    saved["admin"] = True
    body = _get()
    assert body["agent_default"] == ADMIN_PICK
    assert _agents(body)[PLAIN_AGENT] == {
        "agent_id": PLAIN_AGENT,
        "name": "plain",
        "saved": None,
        "effective": ADMIN_PICK,
        "fallback": False,
    }


def test_the_admins_agent_with_a_model_of_its_own_resolves_as_a_users(
    saved: dict[str, Any],
) -> None:
    saved["admin"] = True
    chosen = _agents(_get())[CHOSEN_AGENT]
    assert (chosen["saved"], chosen["effective"], chosen["fallback"]) == (CHOSEN, CHOSEN, False)
