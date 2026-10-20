"""The `agent_scans` rows: the agent a scan is for, its start, and its finish (D50).

A scan's row is written when it starts - outcome NULL, so the partial unique
index `agent_scans_one_running` turns a second concurrent scan of the same agent
into a refusal rather than a second bill - and finished once, with everything
the *Decisions* tab shows: the outcome, the steps, the cost and the transcript.

A scan the process never finished would hold the agent's slot forever. Before a
scan starts, any of the agent's scans that began more than `ABANDONED_AFTER` ago
and never finished is closed as `failed`, so a crash costs one row's honesty and
not the agent's ability to scan again.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

from app.agents.mandate import Mandate, ready_to_scan

#: Matches `0064_monthly_cap.SCAN_OUTCOMES`; a test holds the two equal.
ScanOutcome = Literal[
    "trade",
    "no_trade",
    "invalid_answer",
    "budget_reached",
    "step_limit",
    "failed",
    "rule_rejected",
    "cap_reached",
]
ScanTrigger = Literal["manual", "schedule"]

#: Longer than a scan may run (`scan.SCAN_TIME_LIMIT`), so a live scan is never
#: closed under itself.
ABANDONED_AFTER = timedelta(minutes=15)


@dataclass(frozen=True)
class ScanAgent:
    agent_id: str
    user_id: str
    name: str
    persona: str | None
    state: str
    is_primary: bool
    #: `user_settings.language`: the thesis is written in it (D51).
    language: str = "en"
    #: The template creator's settings (0057); empty for an agent never edited.
    mandate: Mandate = Mandate()
    #: Trades one answer may decide (0061, D197).
    max_decisions: int = 1

    @property
    def ready(self) -> bool:
        """Whether it has anything to decide by: instructions or a mandate (D174)."""
        return ready_to_scan(self.persona, self.mandate.is_set)


class ScanAlreadyRunningError(RuntimeError):
    """The agent has a scan in flight; a second would be a second bill."""


def find_agent(engine: Engine, user_id: str, agent_id: str) -> ScanAgent | None:
    with engine.connect() as connection:
        row = connection.execute(
            text(
                """
                SELECT a.id::text AS id, a.user_id::text AS user_id, a.name, a.persona,
                       a.state, a.is_primary, coalesce(s.language, 'en') AS language,
                       a.risk_level, a.horizon, a.thesis_style, a.max_position_bps,
                       a.cash_buffer_bps, a.max_holdings, a.allow_etfs, a.market_caps,
                       a.sectors, a.industries, a.etf_categories, a.blocked_symbols,
                       a.max_decisions
                  FROM agents a
                  LEFT JOIN user_settings s ON s.user_id = a.user_id
                 WHERE a.id = CAST(:agent AS uuid) AND a.user_id = CAST(:user AS uuid)
                """
            ),
            {"agent": agent_id, "user": user_id},
        ).one_or_none()
    if row is None:
        return None
    return ScanAgent(
        agent_id=row.id,
        user_id=row.user_id,
        name=row.name,
        persona=row.persona,
        state=row.state,
        is_primary=row.is_primary,
        language=row.language,
        max_decisions=row.max_decisions,
        mandate=Mandate(
            risk_level=row.risk_level,
            horizon=row.horizon,
            thesis_style=row.thesis_style,
            max_position_bps=row.max_position_bps,
            cash_buffer_bps=row.cash_buffer_bps,
            max_holdings=row.max_holdings,
            allow_etfs=row.allow_etfs,
            market_caps=tuple(row.market_caps),
            sectors=tuple(row.sectors),
            industries=tuple(row.industries),
            etf_categories=tuple(row.etf_categories),
            blocked_symbols=tuple(row.blocked_symbols),
        ),
    )


def start_scan(
    engine: Engine,
    agent: ScanAgent,
    trigger: ScanTrigger,
    briefing: dict[str, Any],
    now: datetime,
) -> str:
    """Write the running row and answer its id; refuse if one is already running."""
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                UPDATE agent_scans
                   SET finished_at = :now, outcome = 'failed',
                       error = 'abandoned: the scan never finished'
                 WHERE agent_id = CAST(:agent AS uuid)
                   AND finished_at IS NULL
                   AND started_at < :cutoff
                """
            ),
            {"agent": agent.agent_id, "now": now, "cutoff": now - ABANDONED_AFTER},
        )
    try:
        with engine.begin() as connection:
            return connection.execute(
                text(
                    """
                    INSERT INTO agent_scans (user_id, agent_id, trigger, started_at, briefing)
                    VALUES (CAST(:user AS uuid), CAST(:agent AS uuid), :trigger, :now,
                            CAST(:briefing AS jsonb))
                    RETURNING id::text
                    """
                ),
                {
                    "user": agent.user_id,
                    "agent": agent.agent_id,
                    "trigger": trigger,
                    "now": now,
                    "briefing": json.dumps(briefing, ensure_ascii=False, default=str),
                },
            ).scalar_one()
    except IntegrityError as error:
        if "agent_scans_one_running" in str(error):
            raise ScanAlreadyRunningError(agent.agent_id) from error
        raise


def finish_scan(
    engine: Engine,
    scan_id: str,
    *,
    outcome: ScanOutcome,
    steps: int,
    cost_micro_usd: int,
    model: str | None,
    transcript: list[dict[str, Any]],
    answer: dict[str, Any] | None,
    error: str | None,
    now: datetime,
) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                UPDATE agent_scans
                   SET finished_at = :now, outcome = :outcome, steps = :steps,
                       cost_micro_usd = :cost, model = :model,
                       transcript = CAST(:transcript AS jsonb),
                       answer = CAST(:answer AS jsonb), error = :error
                 WHERE id = CAST(:id AS uuid) AND finished_at IS NULL
                """
            ),
            {
                "id": scan_id,
                "now": now,
                "outcome": outcome,
                "steps": steps,
                "cost": cost_micro_usd,
                "model": model,
                "transcript": json.dumps(transcript, ensure_ascii=False, default=str),
                "answer": None if answer is None else json.dumps(answer, ensure_ascii=False),
                "error": error,
            },
        )
