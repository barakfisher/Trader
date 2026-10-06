"""What a model choice would cost per day and per month, as an estimate (D44).

Two bases, one per scope, each measured where it can be and assumed, and said
so, where it cannot:

- **explain** (narration and `/ask`): the tokens actually sent and received by
  completed calls over the last `EXPLAIN_WINDOW_DAYS`, averaged per day and
  re-priced at the candidate model. What the installation really asks for, at
  another model's rates.
- **agent**: each agent that would scan - simulated, active, with a persona
  (D52) - times its scans a day, times the tokens of one scan. Until real
  scans are recorded (Stage 4, PR 3) the tokens per scan are §14.1's
  assumption, and the basis says `assumed`; one scan a day is the default
  schedule's (D46).

Prompt caching is ignored, so the estimate leans high - the safe direction for
a figure that answers "how much should I add". Money is Decimal and the result
integer micro-USD, rounded up once (guideline 3, as `pricing.py`).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_CEILING, Decimal
from typing import Literal

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.llm.base import MICRO_USD_PER_USD
from app.llm.pricing import ModelPrice

#: How far back the explain basis looks. A week covers the weekday/weekend cycle.
EXPLAIN_WINDOW_DAYS = 7
#: §14.1's typical scan: a ~4,000-token briefing and five tool calls, re-sent each step.
ASSUMED_SCAN_PROMPT_TOKENS = 45_000
#: §14.1: ~300 completion tokens a step, rounded up.
ASSUMED_SCAN_COMPLETION_TOKENS = 2_000
#: D46's default schedule: pre-open, once a day.
DEFAULT_SCANS_PER_DAY = 1
#: A month, for the monthly figure: what a reader multiplies by in their head.
DAYS_PER_MONTH = 30

_TOKENS_PER_MILLION = Decimal(1_000_000)


@dataclass(frozen=True)
class ExplainBasis:
    window_days: int
    prompt_tokens_per_day: Decimal
    completion_tokens_per_day: Decimal


@dataclass(frozen=True)
class AgentBasis:
    scanning_agents: int
    scans_per_day: int
    prompt_tokens_per_scan: int
    completion_tokens_per_scan: int
    source: Literal["assumed", "measured"]


@dataclass(frozen=True)
class Estimate:
    daily_micro_usd: int
    monthly_micro_usd: int


def explain_basis(engine: Engine) -> ExplainBasis:
    with engine.connect() as connection:
        row = connection.execute(
            text(
                """
                SELECT coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
                       coalesce(sum(completion_tokens), 0) AS completion_tokens
                  FROM llm_calls
                 WHERE purpose IN ('narration', 'ask')
                   AND outcome = 'ok'
                   AND started_at >= now() - make_interval(days => :days)
                """
            ),
            {"days": EXPLAIN_WINDOW_DAYS},
        ).one()
    days = Decimal(EXPLAIN_WINDOW_DAYS)
    return ExplainBasis(
        window_days=EXPLAIN_WINDOW_DAYS,
        prompt_tokens_per_day=Decimal(row.prompt_tokens) / days,
        completion_tokens_per_day=Decimal(row.completion_tokens) / days,
    )


def agent_basis(engine: Engine) -> AgentBasis:
    with engine.connect() as connection:
        scanning = connection.execute(
            text(
                """
                SELECT count(*) FROM agents
                 WHERE NOT is_primary AND state = 'active' AND persona IS NOT NULL
                """
            )
        ).scalar_one()
    return AgentBasis(
        scanning_agents=int(scanning),
        scans_per_day=DEFAULT_SCANS_PER_DAY,
        prompt_tokens_per_scan=ASSUMED_SCAN_PROMPT_TOKENS,
        completion_tokens_per_scan=ASSUMED_SCAN_COMPLETION_TOKENS,
        source="assumed",
    )


def _micro_usd(prompt_tokens: Decimal, completion_tokens: Decimal, price: ModelPrice) -> Decimal:
    usd = (
        prompt_tokens * price.prompt_usd_per_mtok
        + completion_tokens * price.completion_usd_per_mtok
    ) / _TOKENS_PER_MILLION
    return usd * Decimal(MICRO_USD_PER_USD)


def _estimate(daily_micro_usd: Decimal) -> Estimate:
    def rounded(value: Decimal) -> int:
        return int(value.to_integral_value(rounding=ROUND_CEILING))

    return Estimate(
        daily_micro_usd=rounded(daily_micro_usd),
        monthly_micro_usd=rounded(daily_micro_usd * DAYS_PER_MONTH),
    )


def explain_estimate(basis: ExplainBasis, price: ModelPrice) -> Estimate:
    return _estimate(
        _micro_usd(basis.prompt_tokens_per_day, basis.completion_tokens_per_day, price)
    )


def agent_estimate(basis: AgentBasis, price: ModelPrice) -> Estimate:
    scans = Decimal(basis.scanning_agents * basis.scans_per_day)
    return _estimate(
        _micro_usd(
            scans * basis.prompt_tokens_per_scan, scans * basis.completion_tokens_per_scan, price
        )
    )


def scan_estimate_micro_usd(basis: AgentBasis, price: ModelPrice) -> int:
    """One scan's cost: what an agent with nothing recorded yet is shown (D46)."""
    return int(
        _micro_usd(
            Decimal(basis.prompt_tokens_per_scan), Decimal(basis.completion_tokens_per_scan), price
        ).to_integral_value(rounding=ROUND_CEILING)
    )
