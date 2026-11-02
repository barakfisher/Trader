"""`GET /llm/users/{id}/models`: what each of a user's agents runs on (D244, D360).

The resolution itself is `test_user_models.py`'s and the SQL is
`integration/test_user_models_sql.py`'s. What is pinned here is what the page
shows: an agent with no model of its own on the tested model, one with a model
on it - for every user, the admin included, since there is no Admin page choice
any more (D360).
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


@pytest.fixture(autouse=True)
def saved(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    class Users:
        def __init__(self, engine: object) -> None: ...

        def all_for(self, user_id: str) -> UserModels:
            return UserModels(
                explain=None,
                assistant=CHOSEN,
                agents=(
                    AgentModel(agent_id=CHOSEN_AGENT, name="chosen", saved=CHOSEN),
                    AgentModel(agent_id=PLAIN_AGENT, name="plain", saved=None),
                ),
            )

    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        internal_api_key=INTERNAL_KEY,
        llm_provider="openrouter",
    )
    monkeypatch.setattr(llm_router, "DatabaseUserModels", Users)
    monkeypatch.setattr(llm_router, "get_settings", lambda: settings)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_engine] = lambda: object()
    app.state.listed_models = Listed()
    yield
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


def test_an_agent_with_no_model_runs_on_the_tested_model() -> None:
    assert _agents(_get())[PLAIN_AGENT] == {
        "agent_id": PLAIN_AGENT,
        "name": "plain",
        "saved": None,
        "effective": FALLBACK_MODEL,
        "fallback": False,
    }


def test_an_agent_with_a_model_of_its_own_runs_on_it() -> None:
    chosen = _agents(_get())[CHOSEN_AGENT]
    assert (chosen["saved"], chosen["effective"], chosen["fallback"]) == (CHOSEN, CHOSEN, False)


def test_the_two_user_wide_scopes_resolve_the_same_way() -> None:
    choices = {choice["scope"]: choice for choice in _get()["choices"]}
    assert (choices["explain"]["saved"], choices["explain"]["effective"]) == (None, FALLBACK_MODEL)
    assert (choices["assistant"]["saved"], choices["assistant"]["effective"]) == (CHOSEN, CHOSEN)
    assert "admin" not in _get() and "agent_default" not in _get()
