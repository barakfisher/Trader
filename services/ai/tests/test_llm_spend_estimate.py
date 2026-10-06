"""What a model choice is estimated to cost (D44)."""

from __future__ import annotations

from decimal import Decimal

from app.llm.base import MICRO_USD_PER_USD
from app.llm.pricing import ModelPrice
from app.llm.spend_estimate import (
    ASSUMED_SCAN_COMPLETION_TOKENS,
    ASSUMED_SCAN_PROMPT_TOKENS,
    DAYS_PER_MONTH,
    DEFAULT_SCANS_PER_DAY,
    AgentBasis,
    ExplainBasis,
    agent_estimate,
    explain_estimate,
    scan_estimate_micro_usd,
)

PRICE = ModelPrice(Decimal("2"), Decimal("10"))


def _usd_micro(prompt: Decimal, completion: Decimal) -> Decimal:
    return (
        (prompt * PRICE.prompt_usd_per_mtok + completion * PRICE.completion_usd_per_mtok)
        / Decimal(1_000_000)
        * MICRO_USD_PER_USD
    )


def _basis(agents: int) -> AgentBasis:
    return AgentBasis(
        scanning_agents=agents,
        scans_per_day=DEFAULT_SCANS_PER_DAY,
        prompt_tokens_per_scan=ASSUMED_SCAN_PROMPT_TOKENS,
        completion_tokens_per_scan=ASSUMED_SCAN_COMPLETION_TOKENS,
        source="assumed",
    )


def test_explain_reprices_the_measured_tokens_per_day():
    basis = ExplainBasis(7, Decimal(5000), Decimal(900))
    estimate = explain_estimate(basis, PRICE)
    daily = _usd_micro(Decimal(5000), Decimal(900))
    assert estimate.daily_micro_usd == int(daily)
    assert estimate.monthly_micro_usd == int(daily * DAYS_PER_MONTH)


def test_agents_cost_scans_times_the_tokens_of_one():
    one = scan_estimate_micro_usd(_basis(1), PRICE)
    assert one == int(
        _usd_micro(Decimal(ASSUMED_SCAN_PROMPT_TOKENS), Decimal(ASSUMED_SCAN_COMPLETION_TOKENS))
    )
    three = agent_estimate(_basis(3), PRICE)
    assert three.daily_micro_usd == 3 * DEFAULT_SCANS_PER_DAY * one
    assert three.monthly_micro_usd == three.daily_micro_usd * DAYS_PER_MONTH


def test_no_scanning_agent_costs_nothing():
    assert agent_estimate(_basis(0), PRICE).daily_micro_usd == 0


def test_an_estimate_rounds_up_once():
    # A tenth of a token a day at $2 per million is 0.2 micro-USD: a fraction, rounded up.
    basis = ExplainBasis(7, Decimal("0.1"), Decimal(0))
    assert explain_estimate(basis, PRICE).daily_micro_usd == 1
