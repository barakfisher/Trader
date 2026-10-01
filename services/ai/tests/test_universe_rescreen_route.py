"""`POST /universe/rescreen`: answered at once, and only for a claimed, running rescreen.

The run itself is `tests/integration/test_rescreen_sql.py`'s. What is pinned here
is when the endpoint starts one: never twice in one process, never without a
volume to write to or Yahoo to screen, never for a run nobody claimed.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.db import get_engine
from app.deps import get_embedder, get_profile_source
from app.main import app
from app.routers import universe as universe_router

INTERNAL_KEY = "test-key"
RUN_ID = "11111111-1111-1111-1111-111111111111"


class FakeResult:
    def __init__(self, value: bool) -> None:
        self.value = value

    def scalar_one(self) -> bool:
        return self.value


class FakeConnection:
    def __init__(self, state: dict[str, Any]) -> None:
        self.state = state

    def execute(self, *args: Any, **kwargs: Any) -> FakeResult:
        return FakeResult(self.state["running"])


class FakeEngine:
    def __init__(self, state: dict[str, Any]) -> None:
        self.state = state

    @contextmanager
    def connect(self) -> Iterator[FakeConnection]:
        yield FakeConnection(self.state)


@pytest.fixture
def state(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> Iterator[dict[str, Any]]:
    state: dict[str, Any] = {"running": True, "started": [], "volume": str(tmp_path)}

    async def fake_rescreen(run_id, volume, engine, embedder):  # noqa: ANN001, ANN202
        state["started"].append((run_id, str(volume)))
        universe_router._rescreens.discard(run_id)

    monkeypatch.setattr(universe_router, "_rescreen", fake_rescreen)
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None,  # type: ignore[call-arg]
        internal_api_key=INTERNAL_KEY,
        universe_snapshot_dir=state["volume"],
    )
    app.dependency_overrides[get_engine] = lambda: FakeEngine(state)
    app.dependency_overrides[get_embedder] = lambda: object()
    app.dependency_overrides[get_profile_source] = lambda: state.get("source", object())
    yield state
    app.dependency_overrides.clear()
    universe_router._rescreens.clear()


def _post() -> dict[str, Any]:
    response = TestClient(app).post(
        "/universe/rescreen", json={"run_id": RUN_ID}, headers={"x-internal-key": INTERNAL_KEY}
    )
    assert response.status_code == 202
    return response.json()


def test_starts_a_claimed_run_in_the_background(state: dict[str, Any]) -> None:
    assert _post() == {"run_id": RUN_ID, "status": "started", "reason": None}
    assert state["started"] == [(RUN_ID, state["volume"])]


def test_never_twice_in_one_process(state: dict[str, Any]) -> None:
    universe_router._rescreens.add(RUN_ID)
    assert _post()["status"] == "in_progress"
    assert state["started"] == []


def test_refuses_a_run_nobody_claimed(state: dict[str, Any]) -> None:
    state["running"] = False
    assert _post()["status"] == "not_running"
    assert state["started"] == []


def test_without_a_volume_or_yahoo_it_is_unavailable_and_says_why(
    state: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    state["source"] = None
    answer = _post()
    assert (answer["status"], answer["reason"]) == (
        "unavailable",
        "the market-data chain does not use Yahoo, which the screen is built from",
    )
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None,  # type: ignore[call-arg]
        internal_api_key=INTERNAL_KEY,
    )
    assert "UNIVERSE_SNAPSHOT_DIR" in _post()["reason"]
    assert state["started"] == []
