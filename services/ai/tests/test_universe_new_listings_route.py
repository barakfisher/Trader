"""`POST /universe/new-listings`: when the daily screen runs, and what it answers.

What the run admits is `tests/integration/test_new_listings_sql.py`'s. Pinned
here: only with the internal key, never without a profile source, and a screen
that could not be fetched is a failure the run is retried for - never an empty
"nothing new".
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.db import get_engine
from app.deps import get_embedder, get_profile_source
from app.main import app
from app.routers import universe as universe_router
from app.universe.new_listings import NewListingsReport

INTERNAL_KEY = "test-key"


@pytest.fixture
def state(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    state: dict[str, Any] = {"source": object(), "quotes": [{"symbol": "NEWAI"}], "calls": []}

    def fake_screen() -> list[dict[str, Any]]:
        if isinstance(state["quotes"], Exception):
            raise state["quotes"]
        return state["quotes"]

    async def fake_admit(**kwargs: Any) -> NewListingsReport:
        state["calls"].append(kwargs["quotes"])
        return NewListingsReport(
            screened=1, kept=1, candidates=1, admitted=["NEWAI"], no_description=["LATER"]
        )

    monkeypatch.setattr(universe_router, "screen_market", fake_screen)
    monkeypatch.setattr(universe_router, "admit_new_listings", fake_admit)
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None,  # type: ignore[call-arg]
        internal_api_key=INTERNAL_KEY,
    )
    app.dependency_overrides[get_engine] = lambda: object()
    app.dependency_overrides[get_embedder] = lambda: object()
    app.dependency_overrides[get_profile_source] = lambda: state["source"]
    yield state
    app.dependency_overrides.clear()


def _post(headers: dict[str, str] | None = None) -> Any:
    return TestClient(app).post(
        "/universe/new-listings",
        headers={"x-internal-key": INTERNAL_KEY} if headers is None else headers,
    )


def test_screens_and_answers_what_it_admitted(state: dict[str, Any]) -> None:
    response = _post()
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "done"
    assert body["admitted"] == ["NEWAI"]
    assert body["no_description"] == ["LATER"]
    assert state["calls"] == [state["quotes"]]


def test_without_a_profile_source_it_is_unavailable_and_says_why(state: dict[str, Any]) -> None:
    state["source"] = None
    body = _post().json()
    assert body["status"] == "unavailable"
    assert "Yahoo" in body["reason"]
    assert state["calls"] == []


def test_a_screen_that_could_not_be_fetched_fails_the_request(state: dict[str, Any]) -> None:
    state["quotes"] = RuntimeError("429 Too Many Requests")
    response = _post()
    assert response.status_code == 502
    assert state["calls"] == []


def test_refuses_a_caller_without_the_internal_key(state: dict[str, Any]) -> None:
    assert _post(headers={}).status_code in (401, 403)
    assert state["calls"] == []
