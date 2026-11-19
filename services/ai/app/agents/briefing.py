"""The briefing every scan opens with (D15): what the code tells the model before it asks anything.

An agent never starts blind, and never misses that its own holding collapsed:
the briefing carries its cash and holdings, what the rules find in each holding
today, the day's largest movers that it may trade, the listings the daily screen
added lately (D402), the IPOs about to trade (D404) and what the universe holds on
the topics the agent follows (D412). Everything after that the model asks for with
tools.

What it offers, it offers within the agent's mandate (D412): a mover, a new
listing or a topic's candidate that `mandate.universe_problems` would refuse is
left out before the lists are cut, so the agent is not shown what it may not buy.

It is assembled from the tools' own answers (`get_position`, `get_findings`),
so a figure reads the same in the briefing as in a tool result - one form for
the thesis to quote and the evidence validator to match (§6.2). Like the tools,
it is JSON and it is stored with the scan's transcript (D50).

It makes no model call. Its provider calls are bounded: one movers list (cached
across every agent in a slot), a backfill only for a holding with too few
stored closes, and one embedding per followed topic.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import text

from app.agents.mandate import Mandate, UniverseProfile, member_profiles, universe_problems
from app.agents.tools import ToolContext, get_findings, get_position, money
from app.core.logging import get_logger
from app.corpus.embeddings import EmbeddingError
from app.filings.upcoming import recent_upcoming_listings
from app.models import Mover, MoverList
from app.topics.resolution import resolve_topic

log = get_logger("agents.briefing")

#: Movers shown per list, after the universe filter.
MOVERS_PER_LIST = 5

_LISTS: tuple[MoverList, ...] = ("gainers", "losers", "most_active")

#: The sections' keys, which the scan's instructions name (D411, D412).
NEW_IN_UNIVERSE_KEY = "new_in_universe"
UPCOMING_IPOS_KEY = "upcoming_ipos"
FOLLOWED_TOPICS_KEY = "followed_topics"

#: Topics an agent follows, and how long one may be (D413): migration 0090's CHECK
#: and `packages/shared`'s, held equal by `test_agent_topics.py`.
MAX_TOPICS = 5
MAX_TOPIC_LENGTH = 80
#: Candidates shown per followed topic (D413), after the mandate, what the agent
#: holds and earlier topics have taken theirs: five, as many as a movers list.
CANDIDATES_PER_TOPIC = 5

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


def _within(mandate: Mandate, symbol: str, profiles: Mapping[str, UniverseProfile]) -> bool:
    """Tradable, and inside the agent's universe: what a buy of it would pass (D412)."""
    profile = profiles.get(symbol)
    return profile is not None and not universe_problems(mandate, symbol, profile)


def movers_section(
    context: ToolContext, movers: list[Mover], mandate: Mandate = Mandate()
) -> dict[str, Any]:
    """The day's movers an agent may trade, largest first, per list."""
    profiles = member_profiles(context.engine, sorted({mover.symbol for mover in movers}))
    section: dict[str, Any] = {}
    for kind in _LISTS:
        listed = [m for m in movers if m.list == kind and _within(mandate, m.symbol, profiles)]
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


def new_listings_section(
    context: ToolContext, mandate: Mandate = Mandate()
) -> list[dict[str, Any]]:
    """Listings the daily screen admitted in the last `NEW_LISTING_DAYS`, largest first.

    Only what this agent may buy: a `listed` member priced in USD, inside its
    mandate. The window is read whole and cut after the mandate, so a narrow
    mandate still sees its ten. `added_on` is when the screen admitted it.
    """
    since = context.now - timedelta(days=NEW_LISTING_DAYS)
    with context.engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                SELECT i.symbol, i.name, i.asset_class, p.sector, p.industry, p.category,
                       p.market_cap_minor, p.size_currency, p.size_as_of
                  FROM instruments i
                  JOIN instrument_profiles p ON p.instrument_id = i.id
                 WHERE p.membership = 'listed'
                   AND upper(i.currency) = 'USD'
                   AND p.size_as_of >= :since
                 ORDER BY COALESCE(p.market_cap_minor, p.net_assets_minor) DESC NULLS LAST,
                          i.symbol
                """
            ),
            {"since": since},
        ).all()
    allowed = [
        row
        for row in rows
        if not universe_problems(
            mandate,
            row.symbol,
            UniverseProfile(
                row.asset_class,
                row.sector,
                row.industry,
                row.category,
                row.market_cap_minor,
                row.size_currency,
            ),
        )
    ]
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
        for row in allowed[:MAX_NEW_LISTINGS]
    ]


def upcoming_ipos_section(
    context: ToolContext, mandate: Mandate = Mandate()
) -> list[dict[str, Any]]:
    """Companies registered on an exchange or priced in the last `UPCOMING_IPO_DAYS`.

    Not tradable yet: one becomes so when it lists and appears in
    `new_in_universe` or a quote calls it tradable (the scan's `UPCOMING_IPO_RULE`).
    Dates and stages only (D405). Of the mandate only the blocked list applies: a
    company with no listing has no profile to hold against the rest.
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
        taken = member_profiles(
            context.engine, sorted({listing.ticker for listing in listings if listing.ticker})
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
        if listing.ticker is None or listing.ticker not in mandate.blocked_symbols
    ]


async def followed_topics_section(
    context: ToolContext, topics: tuple[str, ...], mandate: Mandate, held: set[str]
) -> list[dict[str, Any]]:
    """What the universe holds on each topic the agent follows (D412-D413).

    Each topic is resolved as `search_universe` resolves a query, and keeps its first
    `CANDIDATES_PER_TOPIC` candidates, largest first, that the agent may buy and does
    not hold. A symbol an earlier topic showed is not shown again. A topic with nothing
    left says why, so the agent does not search for it again. An embedding that
    fails costs that topic its candidates for the day, never the scan.
    """
    shown = set(held)
    section: list[dict[str, Any]] = []
    for position, topic in enumerate(topics):
        try:
            with context.engine.connect() as connection:
                resolution = await resolve_topic(connection, context.embedder, topic)
        except EmbeddingError as error:
            # The position, not the words: a topic is the user's own text.
            log.warning("briefing.topic_unresolved", topic_position=position, error=str(error))
            section.append({"topic": topic, "note": "could not be searched today"})
            continue
        candidates = [
            candidate
            for interpretation in resolution.interpretations
            for candidate in interpretation.candidates
        ]
        profiles = member_profiles(context.engine, [c.symbol for c in candidates])
        matches: list[dict[str, Any]] = []
        for candidate in candidates:
            if candidate.symbol in shown or not _within(mandate, candidate.symbol, profiles):
                continue
            shown.add(candidate.symbol)
            matches.append(
                {
                    "symbol": candidate.symbol,
                    "name": candidate.name,
                    "kind": candidate.asset_class,
                    "industry": candidate.industry,
                    "confidence": candidate.confidence,
                }
            )
            if len(matches) == CANDIDATES_PER_TOPIC:
                break
        if matches:
            section.append({"topic": topic, "matches": matches})
        elif candidates:
            section.append(
                {
                    "topic": topic,
                    "note": "every match is held, shown under another topic,"
                    " or outside this agent's mandate",
                }
            )
        else:
            section.append({"topic": topic, "note": "nothing in the universe matches this closely"})
    return section


async def build_briefing(
    context: ToolContext,
    movers: list[Mover],
    *,
    mandate: Mandate = Mandate(),
    topics: tuple[str, ...] = (),
) -> dict[str, Any]:
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
        "movers": movers_section(context, movers, mandate),
    }
    # Left out when empty: an empty list is tokens in every scan for nothing. An agent
    # with no topics has no topics section (D414).
    if followed := await followed_topics_section(
        context, topics, mandate, {holding["symbol"] for holding in holdings}
    ):
        briefing[FOLLOWED_TOPICS_KEY] = followed
    if new := new_listings_section(context, mandate):
        briefing[NEW_IN_UNIVERSE_KEY] = new
    if upcoming := upcoming_ipos_section(context, mandate):
        briefing[UPCOMING_IPOS_KEY] = upcoming
    return briefing
