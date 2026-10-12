"""What one user's questions may still spend today (migration 0052).

The allowance is `installation_settings.assistant_daily_budget_micro_usd`, set
on the Admin page ($0.50 until a measured figure replaces it, the user's choice
of 2026-10-11) and applied to each user. Spent is the sum of that user's
recorded `assistant` calls since midnight - `llm_calls` is already the ledger of
every model call, as for an agent's budget (`agents/scan_budget.py`), so no
second counter can drift from it.

Midnight is the user's, not UTC's (guideline 10): the limit was promised to the
user as "until midnight", and a reader in Israel would otherwise see it reset
at two or three in the morning. An agent's budget keeps UTC days (D45); the two
answer to different readers.

Checked before every model call of a question, like an agent's: a question that
crosses the line mid-way stops there, and the call already made is paid for.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.engine import Engine


@dataclass(frozen=True)
class AssistantBudget:
    allowance_micro_usd: int
    spent_micro_usd: int

    @property
    def exhausted(self) -> bool:
        return self.spent_micro_usd >= self.allowance_micro_usd


def start_of_local_day(now: datetime, timezone: str) -> datetime:
    local = now.astimezone(ZoneInfo(timezone))
    return local.replace(hour=0, minute=0, second=0, microsecond=0)


def assistant_budget(engine: Engine, user_id: str, now: datetime, timezone: str) -> AssistantBudget:
    with engine.connect() as connection:
        row = connection.execute(
            text(
                """
                SELECT s.assistant_daily_budget_micro_usd AS allowance,
                       coalesce((
                           SELECT sum(c.cost_micro_usd)
                             FROM llm_calls c
                            WHERE c.user_id = CAST(:user AS uuid)
                              AND c.purpose = 'assistant'
                              AND c.started_at >= :since
                       ), 0) AS spent
                  FROM installation_settings s
                """
            ),
            {"user": user_id, "since": start_of_local_day(now, timezone)},
        ).one()
    return AssistantBudget(allowance_micro_usd=int(row.allowance), spent_micro_usd=int(row.spent))
