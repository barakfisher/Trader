"""What one agent scan would cost on a model, as an estimate (D44, D46).

Each agent that would scan - simulated, active, with a persona (D52) - and the
tokens of one scan. Until real scans are recorded the tokens per scan are
§14.1's assumption, and the basis says `assumed`. A model picker shows the
figure beside each model (D283); the Admin page's daily and monthly totals per
scope went with its pickers (D360).

Prompt caching is ignored, so the estimate leans high - the safe direction for
a figure that answers "how much would this cost". Money is Decimal and the
result integer micro-USD, rounded up once (guideline 3, as `pricing.py`).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_CEILING, Decimal
from typing import Literal

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.llm.base import MICRO_USD_PER_USD
from app.llm.pricing import ModelPrice

#: §14.1's typical scan: a ~4,000-token briefing and five tool calls, re-sent each step.
ASSUMED_SCAN_PROMPT_TOKENS = 45_000
#: §14.1: ~300 completion tokens a step, rounded up.
ASSUMED_SCAN_COMPLETION_TOKENS = 2_000
#: D46's default schedule: pre-open, once a day.
DEFAULT_SCANS_PER_DAY = 1

_TOKENS_PER_MILLION = Decimal(1_000_000)


@dataclass(frozen=True)
class AgentBasis:
    scanning_agents: int
    scans_per_day: int
    prompt_tokens_per_scan: int
    completion_tokens_per_scan: int
    source: Literal["assumed", "measured"]


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


def scan_estimate_micro_usd(basis: AgentBasis, price: ModelPrice) -> int:
    """One scan's cost: what an agent with nothing recorded yet is shown (D46)."""
    return int(
        _micro_usd(
            Decimal(basis.prompt_tokens_per_scan), Decimal(basis.completion_tokens_per_scan), price
        ).to_integral_value(rounding=ROUND_CEILING)
    )
