"""A re-check of an expired trade proposal over real SQL, with a scripted model (D212-D216).

What is pinned: which proposals may be re-checked, that the re-check is a
`refresh` scan naming its proposal, that only the proposal's own symbol and side
can come back, that the old thesis is not evidence, and that "once" is the
database's - with a re-check that reached no answer left out of it.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.agents.recheck import (
    RECHECK_WINDOW,
    UNANSWERED_OUTCOMES,
    NotRecheckableError,
    find_expired_trade,
    run_recheck,
)
from app.agents.scan_log import AlreadyRefreshedError, ScanAgent, start_scan
from tests.integration.test_agent_scan_sql import (
    NOW,
    ScriptedLLM,
    _context,
    _stored,
    _trade,
    _trades,
)
from tests.integration.test_agent_scan_sql import agent as agent  # noqa: F401 - fixture
from tests.integration.test_agent_scan_sql import loaded as loaded  # noqa: F401 - fixture
from tests.integration.test_agent_tools_sql import ScriptedMarket

OLD_THESIS = "CCJ fell 4.10% to 51.00 on a contract delay."


def _proposal(
    engine: Engine,
    agent: ScanAgent,
    *,
    expired_ago: timedelta = timedelta(hours=1),
    state: str = "pending",
    kind: str = "buy",
) -> str:
    """An agent's trade proposal with its scan and observation, its deadline `expired_ago`."""
    with engine.begin() as connection:
        scan = connection.execute(
            text(
                "INSERT INTO agent_scans (user_id, agent_id, trigger, started_at, finished_at, "
                "outcome, briefing, transcript) VALUES (CAST(:u AS uuid), CAST(:a AS uuid), "
                "'manual', :t, :t, 'trade', '{}', '[]') RETURNING id::text"
            ),
            {"u": agent.user_id, "a": agent.agent_id, "t": NOW - expired_ago - timedelta(hours=1)},
        ).scalar_one()
        observation = connection.execute(
            text(
                "INSERT INTO observations (user_id, agent_id, kind, severity, subject_kind, "
                "subject_ref, headline, explanation, dedupe_key, narration_source) VALUES "
                "(CAST(:u AS uuid), CAST(:a AS uuid), 'agent_trade', 'notable', 'instrument', "
                "'instrument:CCJ', 'Scanner proposes to buy 2 CCJ', :thesis, :key, 'llm') "
                "RETURNING id"
            ),
            {
                "u": agent.user_id,
                "a": agent.agent_id,
                "thesis": OLD_THESIS,
                "key": f"agent_scan:{scan}:CCJ",
            },
        ).scalar_one()
        return connection.execute(
            text(
                "INSERT INTO proposals (user_id, agent_id, observation_id, kind, payload, state, "
                "expires_at, scan_id, decided_at, decided_via) VALUES (CAST(:u AS uuid), "
                "CAST(:a AS uuid), :o, :kind, "
                """'{"symbol": "CCJ", "quantity": "2", "priceMinor": 5100, "currency": "USD"}', """
                ":state, :expires, CAST(:s AS uuid), "
                "CASE WHEN :state = 'pending' THEN NULL ELSE now() END, "
                "CASE WHEN :state = 'pending' THEN NULL ELSE 'web' END) RETURNING id::text"
            ),
            {
                "u": agent.user_id,
                "a": agent.agent_id,
                "o": observation,
                "kind": kind,
                "state": state,
                "expires": NOW - expired_ago,
                "s": scan,
            },
        ).scalar_one()


@pytest.fixture()
def market() -> Iterator[ScriptedMarket]:
    scripted = ScriptedMarket()
    scripted.prices = {"CCJ": 5_432, "XOM": 11_000}
    yield scripted


async def _recheck(
    engine: Engine, agent: ScanAgent, proposal: str, llm: ScriptedLLM, market: ScriptedMarket
) -> Any:
    trade = find_expired_trade(engine, agent.user_id, agent.agent_id, proposal, NOW)
    return await run_recheck(
        engine=engine,
        llm=llm,  # type: ignore[arg-type]
        context=_context(engine, agent, market),
        agent=agent,
        trade=trade,
    )


async def test_a_recheck_proposes_the_trade_again_at_the_fresh_price(
    loaded: Engine,  # noqa: F811
    agent: ScanAgent,  # noqa: F811
    market: ScriptedMarket,
) -> None:
    proposal = _proposal(loaded, agent)
    llm = ScriptedLLM(_trades(_trade("buy", "CCJ", "3", "CCJ trades at 54.32 today.")))

    result = await _recheck(loaded, agent, proposal, llm, market)

    assert result.outcome == "trade", result.problems
    row = _stored(loaded, result.scan_id)
    assert (row.trigger, str(row.refreshes_proposal_id)) == ("refresh", proposal)
    assert row.answer["trades"][0]["price_minor"] == 5_432
    assert row.answer["trades"][0]["quantity"] == "3"
    assert row.briefing["recheck"]["price_when_proposed"] == "51.00"
    assert row.briefing["quote"]["quotes"]["CCJ"]["price"] == "54.32"
    # The old thesis is told, outside the briefing.
    assert OLD_THESIS in str(llm.heard[0]) and OLD_THESIS not in str(row.briefing)


async def test_another_symbol_or_side_is_refused(
    loaded: Engine,  # noqa: F811
    agent: ScanAgent,  # noqa: F811
    market: ScriptedMarket,
) -> None:
    proposal = _proposal(loaded, agent)
    llm = ScriptedLLM(_trades(_trade("buy", "XOM", "1", "XOM trades at 110.00.")))

    result = await _recheck(loaded, agent, proposal, llm, market)

    assert result.outcome == "invalid_answer"
    refused = _stored(loaded, result.scan_id).answer["trades"][0]
    assert (refused["refused"], refused["code"]) == (True, "not_this_trade")


async def test_a_figure_only_the_old_thesis_has_is_not_evidence(
    loaded: Engine,  # noqa: F811
    agent: ScanAgent,  # noqa: F811
    market: ScriptedMarket,
) -> None:
    proposal = _proposal(loaded, agent)
    copied = _trade("buy", "CCJ", "2", "CCJ fell 4.10% on a contract delay.")
    llm = ScriptedLLM(_trades(copied), _trades(copied))

    result = await _recheck(loaded, agent, proposal, llm, market)

    assert result.outcome == "invalid_answer"
    refused = _stored(loaded, result.scan_id).answer["trades"][0]
    assert refused["code"] == "figures"


async def test_a_pass_says_why_and_uses_the_recheck_up(
    loaded: Engine,  # noqa: F811
    agent: ScanAgent,  # noqa: F811
    market: ScriptedMarket,
) -> None:
    proposal = _proposal(loaded, agent)
    llm = ScriptedLLM(_trades(thesis="The price is above where it was worth buying."))

    result = await _recheck(loaded, agent, proposal, llm, market)

    assert result.outcome == "no_trade"
    with pytest.raises(NotRecheckableError) as refused:
        find_expired_trade(loaded, agent.user_id, agent.agent_id, proposal, NOW)
    assert refused.value.code == "already_rechecked"
    # The database's own guard, for the race the check above cannot see.
    with pytest.raises(AlreadyRefreshedError):
        start_scan(loaded, agent, "refresh", {}, NOW, refreshes_proposal_id=proposal)


@pytest.mark.parametrize("outcome", UNANSWERED_OUTCOMES)
def test_a_recheck_that_reached_no_answer_does_not_use_it_up(
    loaded: Engine,  # noqa: F811
    agent: ScanAgent,  # noqa: F811
    outcome: str,
) -> None:
    proposal = _proposal(loaded, agent)
    scan = start_scan(loaded, agent, "refresh", {}, NOW, refreshes_proposal_id=proposal)
    with loaded.begin() as connection:
        connection.execute(
            text(
                "UPDATE agent_scans SET finished_at = now(), outcome = :o "
                "WHERE id = CAST(:id AS uuid)"
            ),
            {"o": outcome, "id": scan},
        )
    assert find_expired_trade(loaded, agent.user_id, agent.agent_id, proposal, NOW)
    start_scan(loaded, agent, "refresh", {}, NOW, refreshes_proposal_id=proposal)


@pytest.mark.parametrize(
    ("expired_ago", "state", "kind", "code"),
    [
        (-timedelta(minutes=5), "pending", "buy", "not_expired"),
        (timedelta(hours=1), "rejected", "buy", "not_expired"),
        (timedelta(hours=1), "approved", "sell", "not_expired"),
        (RECHECK_WINDOW + timedelta(minutes=1), "expired", "buy", "recheck_window_passed"),
    ],
)
def test_only_an_unanswered_expiry_within_the_window_is_rechecked(
    loaded: Engine,  # noqa: F811
    agent: ScanAgent,  # noqa: F811
    expired_ago: timedelta,
    state: str,
    kind: str,
    code: str,
) -> None:
    proposal = _proposal(loaded, agent, expired_ago=expired_ago, state=state, kind=kind)
    with pytest.raises(NotRecheckableError) as refused:
        find_expired_trade(loaded, agent.user_id, agent.agent_id, proposal, NOW)
    assert refused.value.code == code


def test_a_swept_expiry_within_the_window_is_rechecked(
    loaded: Engine,  # noqa: F811
    agent: ScanAgent,  # noqa: F811
) -> None:
    proposal = _proposal(loaded, agent, expired_ago=timedelta(days=6), state="expired")
    trade = find_expired_trade(loaded, agent.user_id, agent.agent_id, proposal, NOW)
    assert (trade.side, trade.symbol, trade.price_minor) == ("buy", "CCJ", 5_100)
    assert trade.thesis == OLD_THESIS
