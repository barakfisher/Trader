"""Market data endpoints consumed by the orchestrator.

Responses are plain JSON today; routes are shaped so that a streaming variant can
be added later as `text/event-stream` without changing these payloads.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.analysis.backfill import backfill_history
from app.core.logging import get_logger
from app.db import get_engine
from app.deps import MarketDataDep, require_internal_key
from app.models import (
    BackfillRequest,
    BackfillResponse,
    FxRate,
    InstrumentResolution,
    QuoteRequest,
    QuoteResponse,
)

router = APIRouter(prefix="/market", tags=["market"], dependencies=[Depends(require_internal_key)])
log = get_logger("market")


@router.post("/quotes", response_model=QuoteResponse)
async def get_quotes(payload: QuoteRequest, market: MarketDataDep) -> QuoteResponse:
    quotes, missing = await market.quotes(payload.symbols)
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
    the same safe thing: today's close is added once and everything already
    stored is left alone.
    """
    with get_engine().begin() as connection:
        return await backfill_history(connection, market, payload.instruments, payload.days)
