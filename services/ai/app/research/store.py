"""The research rows: the assigned agent, a run's claim and finish, and each rating (0070).

A run's row is written when it starts, `running`, so the partial unique index
`research_runs_one_running` turns a second concurrent run for the same user
into a refusal rather than a second bill. A run the process never finished - a
restart mid-run - would hold that index forever, so a claim first closes the
user's runs that began more than `ABANDONED_AFTER` ago as `failed`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

ResearchTrigger = Literal["manual", "schedule"]
RunStatus = Literal["running", "done", "failed"]
RatingStatus = Literal["rated", "refused", "failed"]

#: Longer than a run may take (`run.RESEARCH_TIME_LIMIT`), so a live run is never closed.
ABANDONED_AFTER = timedelta(minutes=20)


class ResearchAlreadyRunningError(RuntimeError):
    """The user has a research run in flight; a second would be a second bill."""


@dataclass(frozen=True)
class MainHolding:
    instrument_id: str
    symbol: str
    name: str | None


def research_agent_id(engine: Engine, user_id: str) -> str | None:
    with engine.connect() as connection:
        return connection.execute(
            text(
                "SELECT research_agent_id::text FROM user_settings "
                "WHERE user_id = CAST(:user AS uuid)"
            ),
            {"user": user_id},
        ).scalar_one_or_none()


def main_holdings(engine: Engine, user_id: str) -> list[MainHolding]:
    """The main portfolio's holdings (the primary agent's, D1), by symbol."""
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                SELECT i.id::text AS instrument_id, i.symbol, i.name
                  FROM holdings h
                  JOIN agents a ON a.id = h.agent_id AND a.user_id = h.user_id AND a.is_primary
                  JOIN instruments i ON i.id = h.instrument_id
                 WHERE h.user_id = CAST(:user AS uuid)
                 ORDER BY i.symbol
                """
            ),
            {"user": user_id},
        ).all()
    return [MainHolding(row.instrument_id, row.symbol, row.name) for row in rows]


def claim_run(
    engine: Engine, user_id: str, agent_id: str, trigger: ResearchTrigger, now: datetime
) -> str:
    """Start a run, or refuse with `ResearchAlreadyRunningError`."""
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                UPDATE research_runs
                   SET status = 'failed', finished_at = :now, error = 'abandoned'
                 WHERE user_id = CAST(:user AS uuid) AND status = 'running'
                   AND started_at < :before
                """
            ),
            {"user": user_id, "now": now, "before": now - ABANDONED_AFTER},
        )
    try:
        with engine.begin() as connection:
            return connection.execute(
                text(
                    """
                    INSERT INTO research_runs (user_id, agent_id, trigger, started_at)
                    VALUES (CAST(:user AS uuid), CAST(:agent AS uuid), :trigger, :now)
                    RETURNING id::text
                    """
                ),
                {"user": user_id, "agent": agent_id, "trigger": trigger, "now": now},
            ).scalar_one()
    except IntegrityError as error:
        raise ResearchAlreadyRunningError(user_id) from error


def set_holdings(engine: Engine, run_id: str, holdings: int) -> None:
    with engine.begin() as connection:
        connection.execute(
            text("UPDATE research_runs SET holdings = :holdings WHERE id = CAST(:run AS uuid)"),
            {"run": run_id, "holdings": holdings},
        )


def insert_rating(
    engine: Engine,
    *,
    run_id: str,
    user_id: str,
    agent_id: str,
    holding: MainHolding,
    status: RatingStatus,
    rating: str | None,
    rationale: str | None,
    findings: tuple[str, ...],
    evidence: dict[str, Any],
    problems: list[str],
    model: str | None,
    now: datetime,
) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO research_ratings
                    (run_id, user_id, agent_id, instrument_id, symbol, status, rating,
                     rationale, findings, evidence, problems, model, created_at)
                VALUES (CAST(:run AS uuid), CAST(:user AS uuid), CAST(:agent AS uuid),
                        CAST(:instrument AS uuid), :symbol, :status, :rating, :rationale,
                        CAST(:findings AS jsonb), CAST(:evidence AS jsonb),
                        CAST(:problems AS jsonb), :model, :now)
                """
            ),
            {
                "run": run_id,
                "user": user_id,
                "agent": agent_id,
                "instrument": holding.instrument_id,
                "symbol": holding.symbol,
                "status": status,
                "rating": rating,
                "rationale": rationale,
                "findings": json.dumps(list(findings), ensure_ascii=False),
                "evidence": json.dumps(evidence, ensure_ascii=False, default=str),
                "problems": json.dumps(problems, ensure_ascii=False),
                "model": model,
                "now": now,
            },
        )


def finish_run(
    engine: Engine,
    run_id: str,
    *,
    status: RunStatus,
    rated: int,
    cost_micro_usd: int,
    error: str | None,
    now: datetime,
) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                UPDATE research_runs
                   SET status = :status, rated = :rated, cost_micro_usd = :cost,
                       error = :error, finished_at = :now
                 WHERE id = CAST(:run AS uuid) AND status = 'running'
                """
            ),
            {
                "run": run_id,
                "status": status,
                "rated": rated,
                "cost": cost_micro_usd,
                "error": error,
                "now": now,
            },
        )
