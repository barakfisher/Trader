"""Market data endpoints consumed by the orchestrator.

Responses are plain JSON today; routes are shaped so that a streaming variant can
be added later as `text/event-stream` without changing these payloads.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.analysis.backfill import backfill_history
from app.analysis.quote_history import load_daily_closes
from app.core.logging import get_logger
from app.db import get_engine
from app.deps import MarketDataDep, SettingsDep, require_internal_key
from app.models import (
    BackfillRequest,
    BackfillResponse,
    DailyClosePoint,
    FxRate,
    InstrumentResolution,
    PriceHistoryResponse,
    QuoteRequest,
    QuoteResponse,
)
from app.providers.price_provenance import excluded_price_sources

router = APIRouter(prefix="/market", tags=["market"], dependencies=[Depends(require_internal_key)])
log = get_logger("market")


@router.post("/quotes", response_model=QuoteResponse)
async def get_quotes(payload: QuoteRequest, market: MarketDataDep) -> QuoteResponse:
    quotes, missing = await market.quotes(payload.symbols, payload.markets)
    log.info(
        "market.quotes", requested=len(payload.symbols), returned=len(quotes), missing=len(missing)
    )
    return QuoteResponse(quotes=quotes, missing=missing)


@router.get("/instruments/resolve", response_model=InstrumentResolution)
async def resolve_instrument(
    market: MarketDataDep,
    query: str = Query(min_length=1, max_length=64, description="Symbol or company name"),
) -> InstrumentResolution:
    return await market.resolve(query)


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
