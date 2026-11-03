"""The briefing every scan opens with (D15): what the code tells the model before it asks anything.

An agent never starts blind, and never misses that its own holding collapsed:
the briefing carries its cash and holdings, what the rules find in each holding
today, and the day's largest movers that it may trade. Everything after that the
model asks for with tools.

It is assembled from the tools' own answers (`get_position`, `get_findings`),
so a figure reads the same in the briefing as in a tool result - one form for
the thesis to quote and the evidence validator to match (§6.2). Like the tools,
it is JSON and it is stored with the scan's transcript (D50).

It makes no model call. Its provider calls are bounded: one movers list (cached
across every agent in a slot) and a backfill only for a holding with too few
stored closes.
"""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from sqlalchemy import text

from app.agents.tools import ToolContext, get_findings, get_position, money
from app.models import Mover, MoverList

#: Movers shown per list, after the universe filter.
MOVERS_PER_LIST = 5

_LISTS: tuple[MoverList, ...] = ("gainers", "losers", "most_active")


def _pct(value: float) -> str:
    return str(Decimal(str(value)).quantize(Decimal("0.01")))


def _tradable_symbols(context: ToolContext, symbols: list[str]) -> set[str]:
    """The symbols an agent may trade: in the universe, not dropped, priced in USD.

    The rule `tools.find_listing` applies one symbol at a time (D7, D8), here for
    the whole movers list in one query.
    """
    if not symbols:
        return set()
    with context.engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                SELECT i.symbol
                  FROM instruments i
                  JOIN instrument_profiles p ON p.instrument_id = i.id
                 WHERE i.symbol = ANY(:symbols)
                   AND p.membership <> 'dropped'
                   AND upper(i.currency) = 'USD'
                """
            ),
            {"symbols": symbols},
        ).scalars()
        return set(rows)


def movers_section(context: ToolContext, movers: list[Mover]) -> dict[str, Any]:
    """The day's movers an agent may trade, largest first, per list."""
    tradable = _tradable_symbols(context, sorted({mover.symbol for mover in movers}))
    section: dict[str, Any] = {}
    for kind in _LISTS:
        listed = [m for m in movers if m.list == kind and m.symbol in tradable]
        if kind != "most_active":
            listed.sort(key=lambda m: abs(m.change_pct), reverse=True)
        section[kind] = [
            {
                "symbol": mover.symbol,
                "change_percent": _pct(mover.change_pct),
                "price": money(mover.price_minor, mover.currency),
            }
            for mover in listed[:MOVERS_PER_LIST]
        ]
    if not movers:
        section["note"] = "no movers list is available today"
    elif not any(section[kind] for kind in _LISTS):
        section["note"] = "none of today's movers is in the tradable universe"
    return section


async def build_briefing(context: ToolContext, movers: list[Mover]) -> dict[str, Any]:
    """The briefing for one agent's scan. `movers` is `MarketDataService.movers()`,
    passed in so a slot's scans share one fetch and a test can script it."""
    position = await get_position(context, {})
    holdings: list[Mapping[str, Any]] = []
    for holding in position["holdings"]:
        findings = await get_findings(context, {"symbol": holding["symbol"]})
        holdings.append({**holding, "findings": findings.get("findings", [])})
    return {
        "as_of": context.now.isoformat(),
        "cash": position["cash"],
        "holdings": holdings,
        "movers": movers_section(context, movers),
    }
