"""What `POST /research/runs` refuses, and what it starts (D254, D290).

The run itself is tested over real SQL (`integration/test_research_sql.py`);
this file substitutes it and the store, and pins the router: every refusal is
made before a model could be paid for, each with its code, and an accepted
run is started in the background and answered 202.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.agents.scan_budget import AgentBudget
from app.agents.scan_log import ScanAgent
from app.config import Settings, get_settings
from app.db import get_engine
from app.deps import get_embedder, get_market_data, get_vector_store
from app.main import app
from app.research.run import RESEARCH_MAX_HOLDINGS
from app.research.store import MainHolding, ResearchAlreadyRunningError
from app.routers.agents import PAYER_REFUSALS

INTERNAL_KEY = "test-key"
USER = "00000000-0000-0000-0000-000000000001"
AGENT = "90000000-0000-0000-0000-0000000000a1"
RUN = "b0000000-0000-0000-0000-000000000001"
HOLDING = MainHolding("10000000-0000-0000-0000-000000000001", "CCJ", "Cameco")


def _agent(**overrides: Any) -> ScanAgent:
    fields: dict[str, Any] = {
        "agent_id": AGENT,
        "user_id": USER,
        "name": "Analyst",
        "persona": "A patient value investor.",
        "state": "active",
        "is_primary": False,
        **overrides,
    }
    return ScanAgent(**fields)


@pytest.fixture
def research(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    state: dict[str, Any] = {
        "assigned": AGENT,
        "agent": _agent(),
        "spent": 0,
        "holdings": [HOLDING],
        "running": False,
        "ran": [],
    }

    async def fake_run(**kwargs: Any) -> None:
        state["ran"].append(kwargs)

    def fake_claim(*_a: Any) -> str:
        if state["running"]:
            raise ResearchAlreadyRunningError(USER)
        return RUN

    module = "app.routers.research"
    monkeypatch.setattr(f"{module}.research_agent_id", lambda *_a: state["assigned"])
    monkeypatch.setattr(f"{module}.find_agent", lambda *_a: state["agent"])
    monkeypatch.setattr(
        f"{module}.agent_budget",
        lambda *_a: AgentBudget(allowance_micro_usd=500_000, spent_micro_usd=state["spent"]),
    )
    monkeypatch.setattr(f"{module}.main_holdings", lambda *_a: state["holdings"])
    monkeypatch.setattr(f"{module}.claim_run", fake_claim)
    monkeypatch.setattr(f"{module}.run_research", fake_run)
    monkeypatch.setattr("app.routers.agents.payer_refusal", lambda *_a: None)
    yield state


@pytest.fixture
def client() -> Iterator[TestClient]:
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None, internal_api_key=INTERNAL_KEY, llm_provider="openrouter", llm_model="m"
    )
    app.dependency_overrides.clear()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_engine] = lambda: object()
    app.dependency_overrides[get_market_data] = lambda: object()
    app.dependency_overrides[get_vector_store] = lambda: object()
    app.dependency_overrides[get_embedder] = lambda: object()
    previous = getattr(app.state, "llm", None)
    app.state.llm = object()
    yield TestClient(app)
    app.state.llm = previous
    app.dependency_overrides.clear()


def _post(client: TestClient, **payload: Any) -> Any:
    return client.post(
        "/research/runs",
        json={"user_id": USER, **payload},
        headers={"x-internal-key": INTERNAL_KEY},
    )


def _code(response: Any) -> tuple[int, str]:
    return response.status_code, response.json()["detail"]["code"]


def test_an_accepted_run_starts_in_the_background(
    client: TestClient, research: dict[str, Any]
) -> None:
    response = _post(client, trigger="schedule")
    assert response.status_code == 202
    assert response.json() == {"run_id": RUN, "agent_id": AGENT, "holdings": 1}
    assert research["ran"][0]["trigger"] == "schedule"
    assert research["ran"][0]["run_id"] == RUN


def test_the_holdings_count_is_the_runs_limit(client: TestClient, research: dict[str, Any]) -> None:
    research["holdings"] = [HOLDING] * (RESEARCH_MAX_HOLDINGS + 1)
    assert _post(client).json()["holdings"] == RESEARCH_MAX_HOLDINGS


@pytest.mark.parametrize(
    ("change", "code"),
    [
        ({"assigned": None}, "no_research_agent"),
        ({"agent": None}, "no_research_agent"),
        ({"agent": _agent(is_primary=True)}, "no_research_agent"),
        ({"agent": _agent(state="paused")}, "agent_not_active"),
        ({"spent": 500_000}, "budget_spent"),
        ({"holdings": []}, "no_holdings"),
        ({"running": True}, "research_running"),
    ],
)
def test_a_run_that_cannot_start_is_refused_before_any_model_call(
    client: TestClient, research: dict[str, Any], change: dict[str, Any], code: str
) -> None:
    research.update(change)
    assert _code(_post(client)) == (409, code)
    assert research["ran"] == []


@pytest.mark.parametrize("refusal", sorted(PAYER_REFUSALS))
def test_nobody_to_pay_is_refused_up_front(
    client: TestClient,
    research: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    refusal: str,
) -> None:
    monkeypatch.setattr("app.routers.agents.payer_refusal", lambda *_a: refusal)
    assert _code(_post(client)) == (409, refusal)
    assert research["ran"] == []


def test_no_model_is_a_503(client: TestClient, research: dict[str, Any]) -> None:
    app.state.llm = None
    assert _code(_post(client)) == (503, "no_model")
