"""What an agent's scans may still spend today (D45).

Each agent has `llm_budget_micro_usd`, a daily allowance in integer micro-USD
($0.50 by default). Spent is the sum of its recorded `agent_scan` calls since
midnight UTC - `llm_calls` is already the ledger of every model call (decision
87), and migration 0042 made `agent_scan` the one purpose that names an agent,
so an agent's spend is one indexed sum and no second counter can drift from it.

Checked before every model call of a scan, not once per scan: a scan of twelve
steps on a costly model can cross the line midway, and the check exists to stop
it there. A call already made is paid for; the next one is not made.

The installation-wide guard (`app/llm/budget.py`) still applies to every call
as well. This one answers a narrower question: is *this agent* within *its*
allowance.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.engine import Engine


@dataclass(frozen=True)
class AgentBudget:
    allowance_micro_usd: int
    spent_micro_usd: int

    @property
    def exhausted(self) -> bool:
        return self.spent_micro_usd >= self.allowance_micro_usd


def start_of_utc_day(now: datetime) -> datetime:
    return now.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)


def agent_budget(engine: Engine, agent_id: str, now: datetime) -> AgentBudget:
    with engine.connect() as connection:
        row = connection.execute(
            text(
                """
                SELECT a.llm_budget_micro_usd AS allowance,
                       coalesce((
                           SELECT sum(c.cost_micro_usd)
                             FROM llm_calls c
                            WHERE c.agent_id = a.id
                              AND c.purpose = 'agent_scan'
                              AND c.started_at >= :since
                       ), 0) AS spent
                  FROM agents a
                 WHERE a.id = CAST(:agent AS uuid)
                """
            ),
            {"agent": agent_id, "since": start_of_utc_day(now)},
        ).one()
    return AgentBudget(allowance_micro_usd=int(row.allowance), spent_micro_usd=int(row.spent))
