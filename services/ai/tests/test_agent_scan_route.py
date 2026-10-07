"""What `POST /agents/{id}/scans` refuses, and what it puts on the wire.

The scan itself is tested over real SQL (`integration/test_agent_scan_sql.py`);
this file substitutes it and pins the router: every refusal is made before a
model could be paid for, each with its code, and a finished scan is returned
as stored.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.agents.scan import ScanResult
from app.agents.scan_budget import AgentBudget
from app.agents.scan_log import ScanAgent, ScanAlreadyRunningError
from app.config import Settings, get_settings
from app.db import get_engine
from app.deps import get_embedder, get_market_data, get_vector_store
from app.main import app

INTERNAL_KEY = "test-key"
USER = "00000000-0000-0000-0000-000000000001"
AGENT = "90000000-0000-0000-0000-0000000000a1"


def _agent(**overrides: Any) -> ScanAgent:
    fields: dict[str, Any] = {
        "agent_id": AGENT,
        "user_id": USER,
        "name": "Value",
        "persona": "A patient value investor.",
        "state": "active",
        "is_primary": False,
        **overrides,
    }
    return ScanAgent(**fields)


class _Market:
    async def movers(self) -> list[object]:
        return []


@pytest.fixture
def scan(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    state: dict[str, Any] = {"agent": _agent(), "spent": 0, "ran": [], "raise": None}

    async def fake_run(**kwargs: Any) -> ScanResult:
        state["ran"].append(kwargs)
        if state["raise"]:
            raise state["raise"]
        return ScanResult(
            scan_id="b0000000-0000-0000-0000-000000000001",
            outcome="no_trade",
            steps=2,
            cost_micro_usd=41000,
            model="m",
            answer={"decision": "none", "symbol": None, "quantity": None, "thesis": "Nothing."},
        )

    monkeypatch.setattr("app.routers.agents.find_agent", lambda *_a: state["agent"])
    monkeypatch.setattr(
        "app.routers.agents.agent_budget",
        lambda *_a: AgentBudget(allowance_micro_usd=500_000, spent_micro_usd=state["spent"]),
    )
    monkeypatch.setattr("app.routers.agents.run_scan", fake_run)
    yield state


@pytest.fixture
def client() -> Iterator[TestClient]:
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None, internal_api_key=INTERNAL_KEY, llm_provider="openrouter", llm_model="m"
    )
    app.dependency_overrides.clear()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_engine] = lambda: object()
    app.dependency_overrides[get_market_data] = _Market
    app.dependency_overrides[get_vector_store] = lambda: object()
    app.dependency_overrides[get_embedder] = lambda: object()
    previous = getattr(app.state, "llm", None)
    app.state.llm = object()
    yield TestClient(app)
    app.state.llm = previous
    app.dependency_overrides.clear()


def _post(client: TestClient, **payload: Any) -> Any:
    return client.post(
        f"/agents/{AGENT}/scans",
        json={"user_id": USER, **payload},
        headers={"x-internal-key": INTERNAL_KEY},
    )


def test_a_finished_scan_is_returned_as_stored(client: TestClient, scan: dict[str, Any]) -> None:
    response = _post(client)
    assert response.status_code == 200
    body = response.json()
    assert (body["outcome"], body["steps"], body["cost_micro_usd"]) == ("no_trade", 2, 41000)
    assert body["answer"]["decision"] == "none"
    assert scan["ran"][0]["trigger"] == "manual"


@pytest.mark.parametrize(
    ("agent", "status", "code"),
    [
        (None, 404, "agent_not_found"),
        (_agent(is_primary=True), 409, "primary_agent"),
        (_agent(state="paused"), 409, "agent_not_active"),
        (_agent(persona=None), 409, "no_persona"),
    ],
)
def test_an_agent_that_cannot_scan_is_refused_before_any_model_call(
    client: TestClient, scan: dict[str, Any], agent: ScanAgent | None, status: int, code: str
) -> None:
    scan["agent"] = agent
    response = _post(client)
    assert response.status_code == status
    assert response.json()["detail"]["code"] == code
    assert scan["ran"] == []


def test_a_scan_asked_for_now_is_refused_with_the_budget_spent(
    client: TestClient, scan: dict[str, Any]
) -> None:
    scan["spent"] = 500_000
    response = _post(client)
    assert (response.status_code, response.json()["detail"]["code"]) == (409, "budget_spent")
    assert scan["ran"] == []


def test_a_scheduled_scan_runs_with_the_budget_spent_and_records_it(
    client: TestClient, scan: dict[str, Any]
) -> None:
    scan["spent"] = 500_000
    assert _post(client, trigger="schedule").status_code == 200
    assert scan["ran"][0]["trigger"] == "schedule"


def test_a_second_scan_while_one_runs_is_a_conflict(
    client: TestClient, scan: dict[str, Any]
) -> None:
    scan["raise"] = ScanAlreadyRunningError(AGENT)
    response = _post(client)
    assert (response.status_code, response.json()["detail"]["code"]) == (409, "scan_running")


def test_with_no_model_configured_nothing_runs(client: TestClient, scan: dict[str, Any]) -> None:
    off = Settings(_env_file=None, internal_api_key=INTERNAL_KEY, llm_provider="null")  # type: ignore[call-arg]
    app.dependency_overrides[get_settings] = lambda: off
    response = _post(client)
    assert (response.status_code, response.json()["detail"]["code"]) == (503, "no_model")
    assert scan["ran"] == []
