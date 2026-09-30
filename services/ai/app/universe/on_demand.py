"""Profile one listing a user named that the universe lacks (M8, decision 89).

A US equity or ETF outside the snapshot - below the size floor, or listed since
- is priceable at once but has no description. This fetches one, in the
background of the request that asked, and stores it as `on_demand`: the
listing is described within one fetch instead of at the next rescreen, and no
topic is answered from it (see `profiles.py`).

Every way this can end is an outcome with a name, logged, never an exception
to the caller: the request that set it off has long since been answered.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from sqlalchemy.engine import Engine

from app.core.logging import get_logger
from app.corpus.embeddings import BaseEmbedder
from app.universe.profile_source import InstrumentProfileSource, ProfileSourceError
from app.universe.profiles import embed_profile, insert_on_demand, profile_exists
from app.universe.snapshot import screen_exclusion

log = get_logger("universe.on_demand")

OnDemandOutcome = Literal[
    #: A profile was written (and embedded, unless the embedder failed).
    "profiled",
    #: One existed already, of any membership. Nothing to do.
    "already_profiled",
    #: The source knows no equity or ETF by that symbol.
    "no_listing",
    #: A listing the screen can never hold (asset class or venue). Not a gap.
    "outside_screen",
    #: The source has no description for it. Nothing is invented in its place.
    "no_description",
    #: No currency, which `instruments` requires and which is not ours to guess.
    "no_currency",
    #: The source could not be asked. The next time a user names it, it is tried again.
    "source_error",
]


async def profile_on_demand(
    symbol: str,
    *,
    source: InstrumentProfileSource,
    engine: Engine,
    embedder: BaseEmbedder,
) -> OnDemandOutcome:
    outcome = await _profile(symbol, source=source, engine=engine, embedder=embedder)
    log.info("universe.on_demand", symbol=symbol, outcome=outcome)
    return outcome


async def _profile(
    symbol: str,
    *,
    source: InstrumentProfileSource,
    engine: Engine,
    embedder: BaseEmbedder,
) -> OnDemandOutcome:
    with engine.connect() as connection:
        if profile_exists(connection, symbol):
            return "already_profiled"
    try:
        member = await source.profile(symbol)
    except ProfileSourceError as error:
        log.warning("universe.on_demand_source_failed", symbol=symbol, error=str(error))
        return "source_error"
    if member is None:
        return "no_listing"
    if screen_exclusion(member.asset_class, member.exchange) is not None:
        return "outside_screen"
    if member.description is None:
        return "no_description"
    if member.currency is None:
        return "no_currency"

    with engine.begin() as connection:
        instrument_id = insert_on_demand(
            connection,
            member,
            source=source.source,
            license=source.license,
            as_of=datetime.now(UTC),
        )
    if instrument_id is None:
        return "already_profiled"
    try:
        with engine.begin() as connection:
            await embed_profile(connection, instrument_id, embedder)
    except Exception as error:  # noqa: BLE001 - the text is stored; the loader embeds it later
        # `embed_pending` picks up any profile without a vector on the next
        # load, so a failed embedding delays nothing a topic could see: an
        # on-demand profile is never searched.
        log.warning("universe.on_demand_embed_failed", symbol=symbol, error=str(error))
    return "profiled"
