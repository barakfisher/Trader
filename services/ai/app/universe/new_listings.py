"""The daily new-listings screen: members admitted between rescreens (migration 0088).

The universe is a snapshot rebuilt about once a quarter (decision 90). A company
that lists in between - Anthropic, on 2026-11-19, with the next rescreen due on
12-24 - was in no table: no topic found it and no agent could trade it.

This runs Yahoo's screen alone (about 18 s, measured 2026-11-19), keeps one
listing per company as the snapshot does (`select`), and takes every row that
is not a member yet. Each is profiled through the same source and the same rule
as an on-demand profile (`InstrumentProfileSource`, `to_instrument`), and
admitted as `listed`: a member from the next scan on, which a later snapshot
promotes to `screened` or drops.

**It only adds.** Dropping a listing that fell below the floor stays the
rescreen's: a member that crosses the floor back and forth would otherwise
leave and rejoin every few days.

**Nothing is remembered between runs.** A listing Yahoo cannot describe yet -
the listing day itself, when Yahoo had Anthropic's name but no currency or
market cap - is skipped and asked about again the next day, exactly like one
the source failed to answer. Neither is cached as "no description": that would
be the permanent, wrong answer the universe build refuses to cache (see
`screener.py`).

**At most `MAX_ADMITTED_PER_RUN` profiles a run, largest first, within
`PROFILE_BUDGET_SECONDS`.** The first run on production finds about 190
listings since the snapshot; one request should not ask Yahoo for all of them,
and a throttled Yahoo must not keep the run past the orchestrator's timeout.
The rest are the next run's. Because nothing is remembered, a listing that is
turned away every day would come back at the top every day and could keep a
real one out for good. The known such rows - the snapshot's own members that
Yahoo never described (71 in the 2026-09-24 snapshot, more than the cap) - are
therefore asked about last.

**One listing per company, against the members too.** `select` keeps one
share class per company within the day's screen; a class whose company is a
member already (by the screen's name, the key `select` uses) is not admitted
beside it - the rescreen decides which class the universe keeps.

**Every run embeds what is missing a vector**, its own admissions and any an
earlier run admitted without one, so an embedding that failed once is not left
until the next deploy.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.core.logging import get_logger
from app.corpus.embeddings import BaseEmbedder
from app.universe.profile_source import InstrumentProfileSource, ProfileSourceError
from app.universe.profiles import admit_listed, embed_pending, member_names, member_symbols
from app.universe.snapshot import UniverseInstrument, screen_exclusion, select

log = get_logger("universe.new_listings")

#: Profiles fetched in one run; the rest wait for the next run.
MAX_ADMITTED_PER_RUN = 60
#: Profiles asked for at once. Yahoo rate-limits a burst (screener.py).
CONCURRENCY = 4
#: Seconds the profile requests may take in one run; what has not been asked by
#: then is deferred. With the screen (~20 s) and the embeddings it keeps a run
#: inside the orchestrator's five-minute wait, however Yahoo throttles.
PROFILE_BUDGET_SECONDS = 180


@dataclass(slots=True)
class NewListingsReport:
    #: Rows the screen returned, and the listings kept from them (one per company).
    screened: int = 0
    kept: int = 0
    #: Kept listings that are not members yet.
    candidates: int = 0
    #: Kept listings left out because their company is a member under another symbol.
    same_company: int = 0
    #: Candidates beyond this run's cap, left for the next run.
    deferred: int = 0
    admitted: list[str] = field(default_factory=list)
    #: The source knows no equity or ETF by that symbol.
    no_listing: list[str] = field(default_factory=list)
    #: The source places it where the screen never looks (asset class or venue).
    outside_screen: list[str] = field(default_factory=list)
    #: Known but not described yet; asked about again the next run.
    no_description: list[str] = field(default_factory=list)
    #: No currency, which `instruments` requires and which is not ours to guess.
    no_currency: list[str] = field(default_factory=list)
    #: The source could not be asked; asked again the next run.
    failed: list[str] = field(default_factory=list)
    #: Admitted, but the embedding failed; the next run (or load) embeds it.
    unembedded: list[str] = field(default_factory=list)


def _size(quote: Mapping[str, Any]) -> int:
    return int(quote.get("marketCap") or quote.get("netAssets") or 0)


def _snapshot_undescribed(engine: Engine) -> set[str]:
    """The last loaded snapshot's members that had no description (its manifest's list)."""
    with engine.connect() as connection:
        listed = connection.execute(
            text(
                "SELECT manifest -> 'without_description' FROM universe_loads "
                "ORDER BY loaded_at DESC LIMIT 1"
            )
        ).scalar_one_or_none()
    return {str(symbol) for symbol in listed} if isinstance(listed, list) else set()


async def admit_new_listings(
    *,
    engine: Engine,
    embedder: BaseEmbedder,
    source: InstrumentProfileSource,
    quotes: Sequence[Mapping[str, Any]],
    now: datetime,
    budget_seconds: float = PROFILE_BUDGET_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> NewListingsReport:
    """Admit every listing in the screen's `quotes` that is not a member yet."""
    report = NewListingsReport(screened=len(quotes))
    kept = select(quotes)
    report.kept = len(kept)
    with engine.connect() as connection:
        members = member_symbols(connection)
        companies = member_names(connection)
    undescribed = _snapshot_undescribed(engine)
    new = [quote for quote in kept if str(quote["symbol"]) not in members]
    candidates = [quote for quote in new if quote.get("longName") not in companies]
    report.same_company = len(new) - len(candidates)
    candidates.sort(
        key=lambda quote: (
            str(quote["symbol"]) in undescribed,
            -_size(quote),
            str(quote["symbol"]),
        )
    )
    report.candidates = len(candidates)
    todo = [str(quote["symbol"]) for quote in candidates[:MAX_ADMITTED_PER_RUN]]
    report.deferred = len(candidates) - len(todo)

    gate = asyncio.Semaphore(CONCURRENCY)
    started = clock()
    out_of_time = object()

    async def ask(symbol: str) -> object:
        async with gate:
            if clock() - started > budget_seconds:
                return out_of_time
            try:
                return await source.profile(symbol)
            except ProfileSourceError as error:
                log.warning("universe.new_listing_source_failed", symbol=symbol, error=str(error))
                return error

    answers = await asyncio.gather(*(ask(symbol) for symbol in todo))
    for symbol, member in zip(todo, answers, strict=True):
        if member is out_of_time:
            report.deferred += 1
        elif isinstance(member, ProfileSourceError):
            report.failed.append(symbol)
        elif member is None:
            report.no_listing.append(symbol)
        elif screen_exclusion(member.asset_class, member.exchange) is not None:
            report.outside_screen.append(symbol)
        elif member.description is None:
            report.no_description.append(symbol)
        elif member.currency is None:
            report.no_currency.append(symbol)
        else:
            assert isinstance(member, UniverseInstrument)
            _admit(engine, source, member, now, report)
    await _embed(engine, embedder, report)

    log.info(
        "universe.new_listings",
        candidates=report.candidates,
        admitted=len(report.admitted),
        deferred=report.deferred,
        failed=len(report.failed),
        waiting=len(report.no_description) + len(report.no_currency),
    )
    return report


def _admit(
    engine: Engine,
    source: InstrumentProfileSource,
    member: UniverseInstrument,
    now: datetime,
    report: NewListingsReport,
) -> None:
    with engine.begin() as connection:
        instrument_id = admit_listed(
            connection, member, source=source.source, license=source.license, as_of=now
        )
    # None: it became a member between the read above and this write; nothing to do.
    if instrument_id is not None:
        report.admitted.append(member.symbol)


async def _embed(engine: Engine, embedder: BaseEmbedder, report: NewListingsReport) -> None:
    """Embed every profile missing a vector, then name the admitted ones still without one.

    A member without a vector is tradable but not found by a topic, so a failure
    is reported (the run degrades) and the next run tries again.
    """
    try:
        with engine.begin() as connection:
            await embed_pending(connection, embedder)
    except Exception as error:  # noqa: BLE001 - the text is stored; the next run embeds it
        log.warning("universe.new_listing_embed_failed", error=str(error))
    if not report.admitted:
        return
    with engine.connect() as connection:
        report.unembedded = sorted(
            connection.execute(
                text(
                    "SELECT i.symbol FROM instrument_profiles p "
                    "JOIN instruments i ON i.id = p.instrument_id "
                    "WHERE i.symbol = ANY(:symbols) "
                    "AND (p.embedding IS NULL OR p.embedding_model IS DISTINCT FROM :model)"
                ),
                {"symbols": report.admitted, "model": embedder.model},
            ).scalars()
        )
