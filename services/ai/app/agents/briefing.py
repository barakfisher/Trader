"""The briefing every scan opens with (D15): what the code tells the model before it asks anything.

An agent never starts blind, and never misses that its own holding collapsed:
the briefing carries its cash and holdings, what the rules find in each holding
today, the day's largest movers that it may trade, the listings the daily screen
added lately (D402) and the IPOs about to trade (D404). Everything after that the
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
from datetime import UTC, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import text

from app.agents.tools import ToolContext, get_findings, get_position, money
from app.filings.upcoming import recent_upcoming_listings
from app.models import Mover, MoverList

#: Movers shown per list, after the universe filter.
MOVERS_PER_LIST = 5

_LISTS: tuple[MoverList, ...] = ("gainers", "losers", "most_active")

#: The two sections' keys, which the scan's instructions name (D411).
NEW_IN_UNIVERSE_KEY = "new_in_universe"
UPCOMING_IPOS_KEY = "upcoming_ipos"

#: New listings stay in the briefing this long after the daily screen admits
#: them (D409): about ten daily scans, and long enough that a large listing is
#: still in front of every agent the week after.
NEW_LISTING_DAYS = 14
#: New listings shown, largest first (D409): at ~3 admissions a day the window
#: holds ~40, and a large one should not wait behind small ones.
MAX_NEW_LISTINGS = 10
#: Upcoming IPOs shown (D410): registered on an exchange or priced. Filed and
#: amended registrants are mostly companies that will never reach an exchange
#: (52 of 61 tracked on 2026-11-19); these 9 were all real IPOs.
BRIEFING_IPO_STAGES = ("registered", "priced")
#: How far back a registration or pricing counts: an IPO prices within days of
#: its 8-A12B, so anything older has listed, been delayed, or been withdrawn.
UPCOMING_IPO_DAYS = 30
MAX_UPCOMING_IPOS = 10


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


def new_listings_section(context: ToolContext) -> list[dict[str, Any]]:
    """Listings the daily screen admitted in the last `NEW_LISTING_DAYS`, largest first.

    Only what an agent may trade (`_tradable_symbols`' rule): a `listed` member
    priced in USD. `added_on` is when the screen admitted it (`size_as_of`).
    """
    since = context.now - timedelta(days=NEW_LISTING_DAYS)
    with context.engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                SELECT i.symbol, i.name, i.asset_class, p.sector, p.industry, p.category,
                       p.size_as_of
                  FROM instruments i
                  JOIN instrument_profiles p ON p.instrument_id = i.id
                 WHERE p.membership = 'listed'
                   AND upper(i.currency) = 'USD'
                   AND p.size_as_of >= :since
                 ORDER BY COALESCE(p.market_cap_minor, p.net_assets_minor) DESC NULLS LAST,
                          i.symbol
                 LIMIT :limit
                """
            ),
            {"since": since, "limit": MAX_NEW_LISTINGS},
        )
        return [
            {
                "symbol": row.symbol,
                "name": row.name,
                "asset_class": row.asset_class,
                **(
                    {"sector": row.sector, "industry": row.industry}
                    if row.asset_class == "equity"
                    else {"category": row.category}
                ),
                "added_on": row.size_as_of.astimezone(UTC).date().isoformat(),
            }
            for row in rows
        ]


def upcoming_ipos_section(context: ToolContext) -> list[dict[str, Any]]:
    """Companies registered on an exchange or priced in the last `UPCOMING_IPO_DAYS`.

    Not tradable yet: one becomes so when it lists and appears in
    `new_in_universe` or a quote calls it tradable (the scan's `UPCOMING_IPO_RULE`).
    Dates and stages only (D405).
    """
    with context.engine.connect() as connection:
        listings = recent_upcoming_listings(
            connection,
            today=context.now.date(),
            days=UPCOMING_IPO_DAYS,
            limit=MAX_UPCOMING_IPOS,
            stages=BRIEFING_IPO_STAGES,
        )
        # The read model has already left out a ticker this company trades under; a
        # member under the same ticker now is another, older company (D408). Its
        # quote would say "tradable", so the ticker is not shown with this company.
        taken = _tradable_symbols(
            context, sorted({listing.ticker for listing in listings if listing.ticker})
        )
    return [
        {
            "company": listing.company_name,
            "ticker": None if listing.ticker in taken else listing.ticker,
            "stage": listing.stage,
            **{
                key: value.isoformat()
                for key, value in (
                    ("filed_on", listing.filed_on),
                    ("registered_on", listing.registered_on),
                    ("priced_on", listing.priced_on),
                )
                if value is not None
            },
        }
        for listing in listings
    ]


async def build_briefing(context: ToolContext, movers: list[Mover]) -> dict[str, Any]:
    """The briefing for one agent's scan. `movers` is `MarketDataService.movers()`,
    passed in so a slot's scans share one fetch and a test can script it."""
    position = await get_position(context, {})
    holdings: list[Mapping[str, Any]] = []
    for holding in position["holdings"]:
        findings = await get_findings(context, {"symbol": holding["symbol"]})
        holdings.append({**holding, "findings": findings.get("findings", [])})
    briefing: dict[str, Any] = {
        "as_of": context.now.isoformat(),
        "cash": position["cash"],
        "holdings": holdings,
        "movers": movers_section(context, movers),
    }
    # Left out when empty: an empty list is tokens in every scan for nothing.
    if new := new_listings_section(context):
        briefing[NEW_IN_UNIVERSE_KEY] = new
    if upcoming := upcoming_ipos_section(context):
        briefing[UPCOMING_IPOS_KEY] = upcoming
    return briefing
