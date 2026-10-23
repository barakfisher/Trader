"""What `POST /agents/{id}/proposals/{pid}/recheck` refuses, and what it runs (D212-D215).

The re-check itself runs over real SQL (`integration/test_agent_recheck_sql.py`);
here it is substituted, and the router is pinned: the agent is held to a manual
scan's rules, the proposal's own refusals carry their codes, and nothing is
run - so nothing is paid for - when either refuses.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.agents.recheck import ExpiredTrade, NotRecheckableError, preface
from app.agents.scan import ScanResult
from app.agents.scan_budget import AgentBudget
from app.agents.scan_log import AlreadyRefreshedError, ScanAlreadyRunningError
from tests.test_agent_scan_route import AGENT, INTERNAL_KEY, USER, _agent
from tests.test_agent_scan_route import client as client  # noqa: F401 - the fixture

PROPOSAL = "50000000-0000-0000-0000-000000000022"

TRADE = ExpiredTrade(
    proposal_id=PROPOSAL,
    side="buy",
    symbol="CCJ",
    quantity=Decimal(3),
    price_minor=5_432,
    proposed_at=datetime(2026, 10, 19, 13, 30, tzinfo=UTC),
    expired_at=datetime(2026, 10, 19, 14, 30, tzinfo=UTC),
    thesis="CCJ fell 4.10% to 54.32 on a contract delay.",
)


@pytest.fixture
def recheck(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    state: dict[str, Any] = {"agent": _agent(), "spent": 0, "ran": [], "raise": None, "find": None}

    def fake_find(*_a: Any) -> ExpiredTrade:
        if state["find"] is not None:
            raise state["find"]
        return TRADE

    async def fake_run(**kwargs: Any) -> ScanResult:
        state["ran"].append(kwargs)
        if state["raise"]:
            raise state["raise"]
        return ScanResult(
            scan_id="b0000000-0000-0000-0000-000000000002",
            outcome="no_trade",
            steps=1,
            cost_micro_usd=2000,
            model="m",
            answer={"trades": [], "thesis": "Not now.", "problems": []},
        )

    monkeypatch.setattr("app.routers.agents.find_agent", lambda *_a: state["agent"])
    monkeypatch.setattr(
        "app.routers.agents.agent_budget",
        lambda *_a: AgentBudget(allowance_micro_usd=500_000, spent_micro_usd=state["spent"]),
    )
    monkeypatch.setattr("app.routers.agents.find_expired_trade", fake_find)
    monkeypatch.setattr("app.routers.agents.run_recheck", fake_run)
    yield state


def _post(client: TestClient) -> Any:
    return client.post(
        f"/agents/{AGENT}/proposals/{PROPOSAL}/recheck",
        json={"user_id": USER},
        headers={"x-internal-key": INTERNAL_KEY},
    )


def test_a_recheck_runs_the_found_trade_and_answers_as_a_scan(
    client: TestClient,  # noqa: F811
    recheck: dict[str, Any],
) -> None:
    response = _post(client)
    assert response.status_code == 200
    assert response.json()["answer"]["thesis"] == "Not now."
    assert recheck["ran"][0]["trade"] is TRADE


@pytest.mark.parametrize(
    ("agent", "spent", "status", "code"),
    [
        (None, 0, 404, "agent_not_found"),
        (_agent(state="paused"), 0, 409, "agent_not_active"),
        (_agent(is_primary=True), 0, 409, "primary_agent"),
        (_agent(), 500_000, 409, "budget_spent"),
    ],
)
def test_the_agent_is_held_to_a_manual_scans_rules(
    client: TestClient,  # noqa: F811
    recheck: dict[str, Any],
    agent: Any,
    spent: int,
    status: int,
    code: str,
) -> None:
    recheck["agent"], recheck["spent"] = agent, spent
    response = _post(client)
    assert (response.status_code, response.json()["detail"]["code"]) == (status, code)
    assert recheck["ran"] == []


def test_a_user_nobody_may_pay_for_is_refused_before_the_recheck_runs(
    client: TestClient,  # noqa: F811
    recheck: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.routers.agents.payer_refusal", lambda *_a: "own_key_required")
    response = _post(client)
    assert (response.status_code, response.json()["detail"]["code"]) == (409, "own_key_required")
    assert recheck["ran"] == []


@pytest.mark.parametrize(
    ("code", "status"),
    [
        ("proposal_not_found", 404),
        ("not_a_trade", 409),
        ("not_expired", 409),
        ("recheck_window_passed", 409),
        ("already_rechecked", 409),
        ("superseded", 409),
    ],
)
def test_a_proposal_that_cannot_be_rechecked_is_refused_with_its_code(
    client: TestClient,  # noqa: F811
    recheck: dict[str, Any],
    code: str,
    status: int,
) -> None:
    recheck["find"] = NotRecheckableError(code, "why")
    response = _post(client)
    assert (response.status_code, response.json()["detail"]["code"]) == (status, code)
    assert recheck["ran"] == []


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (ScanAlreadyRunningError(AGENT), "scan_running"),
        (AlreadyRefreshedError(PROPOSAL), "already_rechecked"),
    ],
)
def test_a_race_lost_at_the_database_is_a_refusal(
    client: TestClient,  # noqa: F811
    recheck: dict[str, Any],
    error: Exception,
    code: str,
) -> None:
    recheck["raise"] = error
    response = _post(client)
    assert (response.status_code, response.json()["detail"]["code"]) == (409, code)


def test_the_preface_names_the_one_trade_and_fences_the_old_thesis() -> None:
    told = preface(TRADE)
    assert "buy 3 CCJ" in told and "buy CCJ" in told
    assert f"<<<\n{TRADE.thesis}\n>>>" in told
    assert "not evidence" in told


def test_a_proposal_with_no_thesis_is_prefaced_without_one() -> None:
    told = preface(ExpiredTrade(**{**TRADE.__dict__, "thesis": None}))
    assert "<<<" not in told
