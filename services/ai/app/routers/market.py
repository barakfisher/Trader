"""Market data endpoints consumed by the orchestrator.

Responses are plain JSON today; routes are shaped so that a streaming variant can
be added later as `text/event-stream` without changing these payloads.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.analysis.backfill import backfill_history
from app.analysis.quote_history import load_daily_closes
from app.core.exchange_calendar import (
    CalendarNotCovered,
    ExchangeCalendar,
    calendar_name_for,
    load_calendar,
)
from app.core.logging import get_logger
from app.db import get_engine
from app.deps import MarketDataDep, SettingsDep, UniverseMembershipDep, require_internal_key
from app.models import (
    BackfillRequest,
    BackfillResponse,
    DailyClosePoint,
    FxRate,
    InstrumentResolution,
    MarketCalendarStatus,
    MarketSession,
    MarketSessions,
    PriceHistoryResponse,
    QuoteRequest,
    QuoteResponse,
)
from app.providers.price_provenance import excluded_price_sources
from app.universe.membership import universe_status

router = APIRouter(prefix="/market", tags=["market"], dependencies=[Depends(require_internal_key)])
log = get_logger("market")


@router.post("/quotes", response_model=QuoteResponse)
async def get_quotes(payload: QuoteRequest, market: MarketDataDep) -> QuoteResponse:
    quotes, missing = await market.quotes(payload.symbols, payload.markets)
    log.info(
        "market.quotes", requested=len(payload.symbols), returned=len(quotes), missing=len(missing)
    )
    return QuoteResponse(quotes=quotes, missing=missing)


def calendar_status(
    calendar: ExchangeCalendar, exchange: str, now: datetime
) -> MarketCalendarStatus:
    """The calendar's answer for `exchange` at `now`. Raises `CalendarNotCovered`."""
    session = calendar.current_session(now)
    return MarketCalendarStatus(
        exchange=exchange,
        calendar=calendar.name,
        as_of=now,
        is_open=session is not None,
        session_closes_at=session.closes_at if session else None,
        early_close=session.early_close if session else False,
        next_open=calendar.next_session(now).opens_at,
        covered_until=calendar.last_day,
    )


@router.get("/calendar", response_model=MarketCalendarStatus)
async def market_calendar(
    settings: SettingsDep,
    exchange: str = Query(min_length=1, max_length=32, description="Exchange name or code"),
) -> MarketCalendarStatus:
    """Is `exchange` open now, and when does it next open - holidays included.

    422 for an exchange with no calendar: only the US exchanges have one, and a
    trade on a guessed calendar is a wrong fill. 503 when the calendar cannot
    answer (the file missing, or `now` past the years it covers) - never a guess.
    """
    if calendar_name_for(exchange) is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"no exchange calendar is held for {exchange}"
        )
    try:
        calendar = load_calendar(settings.calendar_dir)
        return calendar_status(calendar, exchange, datetime.now(UTC))
    except (OSError, CalendarNotCovered) as error:
        log.error("market.calendar_unavailable", exchange=exchange, error=str(error))
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "the exchange calendar cannot answer"
        ) from error


#: The longest span `/market/sessions` lists: about ten years, the history ceiling.
MAX_SESSION_SPAN_DAYS = 3660


@router.get("/sessions", response_model=MarketSessions)
async def market_sessions(
    settings: SettingsDep,
    exchange: str = Query(min_length=1, max_length=32, description="Exchange name or code"),
    start: date = Query(description="First day, inclusive (YYYY-MM-DD)"),
    end: date = Query(description="Last day, inclusive (YYYY-MM-DD)"),
) -> MarketSessions:
    """Every session of `exchange` from `start` to `end`, with its close (D25).

    The orchestrator reads its trading days and closing instants from here
    rather than keeping a copy of the calendar. 422 for an exchange with no
    calendar or a reversed or over-long span; 503 when the span reaches outside
    the committed file - never a guess about days it does not cover.
    """
    if calendar_name_for(exchange) is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"no exchange calendar is held for {exchange}"
        )
    if end < start or (end - start).days > MAX_SESSION_SPAN_DAYS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"start must not be after end, and the span at most {MAX_SESSION_SPAN_DAYS} days",
        )
    try:
        calendar = load_calendar(settings.calendar_dir)
        sessions = calendar.sessions_between(start, end)
    except (OSError, CalendarNotCovered) as error:
        log.error("market.sessions_unavailable", exchange=exchange, error=str(error))
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "the exchange calendar cannot answer"
        ) from error
    return MarketSessions(
        exchange=exchange,
        calendar=calendar.name,
        sessions=[
            MarketSession(
                day=session.day,
                opens_at=session.opens_at,
                closes_at=session.closes_at,
                early_close=session.early_close,
            )
            for session in sessions
        ],
    )


@router.get("/instruments/resolve", response_model=InstrumentResolution)
async def resolve_instrument(
    market: MarketDataDep,
    membership: UniverseMembershipDep,
    query: str = Query(min_length=1, max_length=64, description="Symbol or company name"),
) -> InstrumentResolution:
    resolution = await market.resolve(query)
    # Whether the universe holds it: a priceable symbol outside the universe is
    # never offered for a topic, and the admin panel reports it as a gap.
    return resolution.model_copy(
        update={"universe": universe_status(resolution.resolved, membership)}
    )


@router.get("/fx", response_model=FxRate)
async def get_fx_rate(
    market: MarketDataDep,
    base: str = Query(min_length=3, max_length=8),
    quote: str = Query(min_length=3, max_length=8),
) -> FxRate:
    rate = await market.fx_rate(base, quote)
    if rate is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"no FX rate available for {base}->{quote}")
    return rate


@router.post("/history/backfill", response_model=BackfillResponse)
async def backfill(payload: BackfillRequest, market: MarketDataDep) -> BackfillResponse:
    """Fill the price history the analysis rules read.

    Idempotent, so a scheduled daily call and a manual one after an import do
    the same safe thing: a finished day's close is added once, a close stored
    while its day was still trading is corrected, and a day still trading is
    not stored at all.
    """
    with get_engine().begin() as connection:
        return await backfill_history(connection, market, payload.instruments, payload.days)


#: How far back a chart may ask. The backfill stores about a year; ten years is
#: the provider contract's own ceiling and keeps a typo from scanning the table.
MAX_HISTORY_DAYS = 3650


@router.get("/history/{instrument_id}", response_model=PriceHistoryResponse)
async def price_history(
    instrument_id: UUID,
    settings: SettingsDep,
    days: int = Query(365, ge=1, le=MAX_HISTORY_DAYS),
) -> PriceHistoryResponse:
    """An instrument's stored daily closes: read from `quotes`, never fetched.

    Real prices only: a real installation skips stored fixture rows here exactly
    as the analysis does (`excluded_price_sources`). An instrument with no stored
    history answers an empty list - "nothing stored yet" is a state, not an error.
    """
    with get_engine().connect() as connection:
        points = load_daily_closes(
            connection,
            instrument_id,
            days=days,
            now=datetime.now(UTC),
            excluded_sources=excluded_price_sources(settings.market_data_chain),
        )
    return PriceHistoryResponse(
        instrument_id=str(instrument_id),
        days=days,
        closes=[
            DailyClosePoint(
                day=point.as_of.date(),
                price_minor=point.price_minor,
                currency=point.currency,
                as_of=point.as_of,
            )
            for point in points
        ],
    )
