"""`POST /assistant/messages` answers in the asking user's day (D163).

The conversation itself is tested over real SQL (`integration/test_assistant_sql.py`);
this file substitutes it and pins the one thing the router decides: which zone
"today", the daily allowance and the next scan's time are read in.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import nullcontext
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.db import get_engine
from app.deps import get_embedder, get_market_data, get_vector_store
from app.main import app

INTERNAL_KEY = "test-key"
USER = "00000000-0000-0000-0000-0000000000b2"
INSTALLATION_ZONE = "Asia/Jerusalem"


class _Engine:
    def connect(self) -> Any:
        return nullcontext(object())


@pytest.fixture
def asked(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    state: dict[str, Any] = {"zone": "America/New_York"}

    async def fake_ask(**kwargs: Any) -> Any:
        state["kwargs"] = kwargs
        return SimpleNamespace(
            conversation_id=None,
            message_id=None,
            outcome="answer",
            reason=None,
            text="ok",
            sources=[],
            suggestions=[],
            model="m",
            cost_micro_usd=0,
            steps=0,
        )

    monkeypatch.setattr("app.routers.assistant.ask", fake_ask)
    monkeypatch.setattr("app.routers.assistant.primary_agent_id", lambda *_a: "agent")
    monkeypatch.setattr("app.routers.assistant.user_timezone", lambda *_a: state["zone"])
    yield state


@pytest.fixture
def client() -> Iterator[TestClient]:
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None,
        internal_api_key=INTERNAL_KEY,
        app_timezone=INSTALLATION_ZONE,
        llm_provider="openrouter",
        llm_model="m",
    )
    app.dependency_overrides.clear()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_engine] = _Engine
    app.dependency_overrides[get_market_data] = lambda: object()
    app.dependency_overrides[get_vector_store] = lambda: object()
    app.dependency_overrides[get_embedder] = lambda: object()
    yield TestClient(app)
    app.dependency_overrides.clear()


def _post(client: TestClient) -> Any:
    return client.post(
        "/assistant/messages",
        json={"user_id": USER, "message": "What happened today?"},
        headers={"x-internal-key": INTERNAL_KEY},
    )


def test_the_users_zone_not_the_installations(client: TestClient, asked: dict[str, Any]) -> None:
    assert _post(client).status_code == 200
    assert asked["kwargs"]["timezone"] == "America/New_York"
    assert asked["kwargs"]["context"].scheduling.timezone == "America/New_York"


def test_the_installations_zone_only_when_the_user_has_none(
    client: TestClient, asked: dict[str, Any]
) -> None:
    asked["zone"] = None
    assert _post(client).status_code == 200
    assert asked["kwargs"]["timezone"] == INSTALLATION_ZONE
