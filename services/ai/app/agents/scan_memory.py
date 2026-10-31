"""What an agent's scan is told about its own last scans (D353).

Every scan used to start from nothing: an hourly agent on compose (8-9 scans a
day, 2026-10-26 to 10-30) wrote "cash 141.28, 14.5% of capital, no opportunity"
eight times in one day, and 56 of 75 consecutive scan pairs were a pass after a
pass. A scan
is now told its last `RECENT_SCANS` decided scans, newest first: when each ran,
what it decided, and what became of each trade it proposed (approved, rejected,
expired, still waiting).

**Facts only** (the user, 2026-10-31): no thesis, which a small model copies
rather than re-reads, and no price, which would be hours old. **Not evidence**:
the list rides in the briefing so the model and the Scans tab both see it, but
`without_memory` takes it out of what the figure check accepts as a source, as
a re-check's preface is kept out (D212). **A rejected trade is shown, not
blocked** (the user, 2026-10-31): the prompt asks for a reason that changed,
and the server refuses nothing on it.

A scan that reached no decision - failed, refused for budget or key, an answer
that could not be read - says nothing about the market and is not listed.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import bindparam, text
from sqlalchemy.engine import Engine

#: How many of the agent's last decided scans a scan is told about (the user, 2026-10-31).
RECENT_SCANS = 3
#: The briefing key the list rides under; never a source for a thesis's figures.
RECENT_SCANS_KEY = "recent_scans"
#: Outcomes that are a decision about the market.
DECIDED_OUTCOMES = ("trade", "no_trade", "rule_rejected")
#: A proposal's state as the model is told it: snoozed is still waiting.
TRADE_STATES = {
    "pending": "waiting",
    "snoozed": "waiting",
    "approved": "approved",
    "rejected": "rejected",
    "expired": "expired",
}


@dataclass(frozen=True)
class RecentTrade:
    side: str
    symbol: str
    quantity: str
    state: str


@dataclass(frozen=True)
class RecentScan:
    at: datetime
    outcome: str
    trades: tuple[RecentTrade, ...]

    def as_briefing(self) -> dict[str, Any]:
        return {
            "at": self.at.isoformat(),
            "outcome": self.outcome,
            "trades": [
                {"side": t.side, "symbol": t.symbol, "quantity": t.quantity, "state": t.state}
                for t in self.trades
            ],
        }


def recent_scans(engine: Engine, user_id: str, agent_id: str) -> list[RecentScan]:
    """The agent's last decided scans, newest first, each with its proposals' fate."""
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                WITH recent AS (
                    SELECT s.id, s.started_at, s.outcome
                      FROM agent_scans s
                     WHERE s.user_id = CAST(:user AS uuid) AND s.agent_id = CAST(:agent AS uuid)
                       AND s.finished_at IS NOT NULL AND s.outcome IN :outcomes
                     ORDER BY s.started_at DESC
                     LIMIT :limit
                )
                SELECT r.id::text AS id, r.started_at, r.outcome, p.kind,
                       p.payload ->> 'symbol' AS symbol, p.payload ->> 'quantity' AS quantity,
                       p.state
                  FROM recent r
                  LEFT JOIN proposals p ON p.scan_id = r.id AND p.kind IN ('buy', 'sell')
                 ORDER BY r.started_at DESC, p.created_at
                """
            ).bindparams(bindparam("outcomes", expanding=True)),
            {
                "user": user_id,
                "agent": agent_id,
                "outcomes": DECIDED_OUTCOMES,
                "limit": RECENT_SCANS,
            },
        ).all()
    scans: dict[str, tuple[datetime, str, list[RecentTrade]]] = {}
    for row in rows:
        _, _, trades = scans.setdefault(row.id, (row.started_at, row.outcome, []))
        if row.kind is not None:
            trades.append(
                RecentTrade(
                    side=row.kind,
                    symbol=row.symbol,
                    quantity=row.quantity,
                    state=TRADE_STATES.get(row.state, row.state),
                )
            )
    return [
        RecentScan(at=at, outcome=outcome, trades=tuple(trades))
        for at, outcome, trades in scans.values()
    ]


def without_memory(briefing: Mapping[str, Any]) -> dict[str, Any]:
    """The briefing as evidence: everything but the recent scans."""
    return {key: value for key, value in briefing.items() if key != RECENT_SCANS_KEY}
