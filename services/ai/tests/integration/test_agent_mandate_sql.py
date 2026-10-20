"""The mandate inside a scan, over real SQL (D165, D170).

The scripted model and fixtures are the scan suite's: what is tested is that a
buy breaking the mandate goes back to the model once, with the reason, and is
stored as `rule_rejected` when it breaks it again.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import replace

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.agents.mandate import Mandate
from app.agents.scan import FIGURES_RETRY_PREFIX, RETRY_PREFIX, instructions
from app.agents.scan_log import ScanAgent, find_agent
from tests.integration.conftest import run_script
from tests.integration.test_agent_scan_sql import (
    ScriptedLLM,
    ScriptedMarket,
    _answer,
    _scan,
    _stored,
)

FIXTURE_EMBEDDER = {"EMBEDDINGS_PROVIDER": "fixture"}

CCJ_PRICE = 5_432


@pytest.fixture(scope="module")
def loaded(migrated: Engine, database_url: str) -> Engine:
    universe = run_script(
        database_url, "scripts/ingest_universe.py", "--fixture", **FIXTURE_EMBEDDER
    )
    assert universe.returncode == 0, universe.stdout + universe.stderr
    return migrated


@pytest.fixture()
def agent(loaded: Engine) -> Iterator[ScanAgent]:
    """A Scanner with 1,000.00 and a 10% position limit, Energy only, no ETFs."""
    with loaded.begin() as connection:
        user = connection.execute(
            text("INSERT INTO users (role) VALUES ('user') RETURNING id::text")
        ).scalar_one()
        agent_id = connection.execute(
            text(
                "INSERT INTO agents (user_id, slug, name, persona, budget_minor, "
                "max_position_bps, allow_etfs, sectors, risk_level, horizon, thesis_style) "
                "VALUES (CAST(:u AS uuid), 'mandated', 'Mandated', 'A patient value investor.', "
                "100000, 1000, false, ARRAY['Energy'], 3, 'long', 'academic') RETURNING id::text"
            ),
            {"u": user},
        ).scalar_one()
    found = find_agent(loaded, user, agent_id)
    assert found is not None
    yield found


def _market() -> ScriptedMarket:
    market = ScriptedMarket()
    market.prices = {"CCJ": CCJ_PRICE}
    return market


def _buy_ccj(quantity: int) -> object:
    return _answer(
        decision="buy",
        symbol="CCJ",
        quantity=str(quantity),
        thesis="CCJ is a uranium miner a patient buyer can hold.",
    )


def test_the_agent_carries_its_mandate(agent: ScanAgent) -> None:
    assert agent.mandate == Mandate(
        risk_level=3,
        horizon="long",
        thesis_style="academic",
        max_position_bps=1000,
        allow_etfs=False,
        sectors=("Energy",),
    )


def test_the_prompt_ranks_the_mandate_above_the_users_words(agent: ScanAgent) -> None:
    prompt = instructions(agent)
    assert "Risk appetite: Conservative." in prompt
    assert "long-term" in prompt
    assert prompt.index("Your mandate") < prompt.index("Additional instructions")
    assert "the mandate and the rules win" in prompt


async def test_a_buy_over_the_limit_goes_back_once_and_a_fitting_one_is_a_trade(
    loaded: Engine, agent: ScanAgent
) -> None:
    # 2 x 54.32 = 108.64, over 10% of 1,000.00; 1 x 54.32 fits.
    llm = ScriptedLLM(_buy_ccj(2), _buy_ccj(1))

    result = await _scan(loaded, agent, llm, _market())

    assert result.outcome == "trade", result.problems
    row = _stored(loaded, result.scan_id)
    assert row.answer["trades"][0]["quantity"] == "1"
    assert row.briefing["mandate"]["max_position_pct_of_capital"] == "10"
    roles = [entry["role"] for entry in row.transcript]
    assert roles == ["assistant", "returned", "assistant"]
    assert "position limit" in row.transcript[1]["problems"][0]
    assert llm.verdicts == ["accepted", "accepted"]


async def test_a_buy_that_breaks_the_mandate_twice_is_rule_rejected(
    loaded: Engine, agent: ScanAgent
) -> None:
    llm = ScriptedLLM(_buy_ccj(2), _buy_ccj(3))

    result = await _scan(loaded, agent, llm, _market())

    assert result.outcome == "rule_rejected"
    row = _stored(loaded, result.scan_id)
    assert row.outcome == "rule_rejected"
    assert row.answer["trades"][0]["quantity"] == "3"
    assert "position limit" in row.answer["problems"][0]


async def test_the_figures_and_the_mandate_each_send_an_answer_back_once(
    loaded: Engine, agent: ScanAgent
) -> None:
    # D189 beside D170: a thesis with an invented figure, then a fixed one over
    # the position limit, then one that fits - three answers, one scan.
    invented = _answer(
        decision="buy", symbol="CCJ", quantity="2", thesis="CCJ will reach 80.00 soon."
    )
    llm = ScriptedLLM(invented, _buy_ccj(2), _buy_ccj(1))

    result = await _scan(loaded, agent, llm, _market())

    assert result.outcome == "trade", result.problems
    row = _stored(loaded, result.scan_id)
    roles = [entry["role"] for entry in row.transcript]
    assert roles == ["assistant", "returned", "assistant", "returned", "assistant"]
    assert FIGURES_RETRY_PREFIX in llm.heard[1].text
    assert RETRY_PREFIX in llm.heard[2].text
    assert llm.verdicts == ["unsourced_figures", "accepted", "accepted"]


async def test_passing_after_the_refusal_is_no_trade(loaded: Engine, agent: ScanAgent) -> None:
    llm = ScriptedLLM(
        _answer(decision="buy", symbol="GDX", quantity="1", thesis="Gold miners."),
        _answer(decision="none", thesis="Nothing in Energy fits today."),
    )
    market = _market()
    market.prices["GDX"] = 3_000

    result = await _scan(loaded, agent, llm, market)

    assert result.outcome == "no_trade"
    row = _stored(loaded, result.scan_id)
    returned = row.transcript[1]["problems"]
    assert any("does not buy ETFs" in problem for problem in returned)
    assert any("outside this agent's sectors" in problem for problem in returned)


async def test_an_agent_with_no_mandate_is_never_sent_back(
    loaded: Engine, agent: ScanAgent
) -> None:
    llm = ScriptedLLM(_buy_ccj(2))

    result = await _scan(loaded, replace(agent, mandate=Mandate()), llm, _market())

    assert result.outcome == "trade"
    assert RETRY_PREFIX not in str(_stored(loaded, result.scan_id).transcript)
