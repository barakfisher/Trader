"""Market data endpoints consumed by the orchestrator.

Responses are plain JSON today; routes are shaped so that a streaming variant can
be added later as `text/event-stream` without changing these payloads.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.logging import get_logger
from app.deps import MarketDataDep, require_internal_key
from app.models import FxRate, InstrumentResolution, QuoteRequest, QuoteResponse

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
