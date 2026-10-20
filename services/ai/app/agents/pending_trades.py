"""An agent's trade proposals still waiting for the user (D197).

A scan is told about them and held to them: the briefing lists each one, a new
trade on the same symbol and side as one of them is refused - an agent scanning
every two hours otherwise proposes the same buy again before the user has read
the first (two "buy 3 IRON" an hour apart, compose, 2026-10-19) - and a buy's
cash check sets aside what the waiting buys would spend, so approving every
proposal never fails for cash.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.agents.tools import money
from app.core.fees import fee_minor, notional_minor


@dataclass(frozen=True)
class PendingTrade:
    side: str
    symbol: str
    quantity: Decimal
    price_minor: int
    expires_at: datetime

    @property
    def cost_minor(self) -> int:
        """What approving it would take from cash: a buy's cost and fee; a sell, nothing."""
        if self.side != "buy":
            return 0
        return notional_minor(self.quantity, self.price_minor) + fee_minor(self.quantity)

    def as_briefing(self) -> dict[str, Any]:
        return {
            "side": self.side,
            "symbol": self.symbol,
            "quantity": f"{self.quantity.normalize():f}",
            "price": money(self.price_minor, "USD"),
            "expires_at": self.expires_at.isoformat(),
        }


def pending_trades(
    engine: Engine, user_id: str, agent_id: str, now: datetime
) -> list[PendingTrade]:
    """The agent's buys and sells waiting for a decision (pending or snoozed, not expired)."""
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                SELECT p.kind, p.payload ->> 'symbol' AS symbol,
                       p.payload ->> 'quantity' AS quantity,
                       (p.payload ->> 'priceMinor')::bigint AS price_minor, p.expires_at
                  FROM proposals p
                 WHERE p.user_id = CAST(:user AS uuid) AND p.agent_id = CAST(:agent AS uuid)
                   AND p.kind IN ('buy', 'sell') AND p.state IN ('pending', 'snoozed')
                   AND p.expires_at > :now
                 ORDER BY p.created_at
                """
            ),
            {"user": user_id, "agent": agent_id, "now": now},
        ).all()
    return [
        PendingTrade(
            side=row.kind,
            symbol=row.symbol,
            quantity=Decimal(row.quantity),
            price_minor=int(row.price_minor),
            expires_at=row.expires_at,
        )
        for row in rows
    ]
