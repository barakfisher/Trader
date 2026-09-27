"""The news collection endpoint the scheduled `news_collect` run calls.

Stateless like the analysis router: the orchestrator decides which instruments
the user follows and when to run; this service fetches, matches, scores and
stores. The write happens here rather than in the orchestrator because the news
tables are shared market data with no `user_id` - the same reason `quotes` is
written by the backfill endpoint and not by the caller.
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends

from app.db import get_engine
from app.deps import SettingsDep, require_internal_key
from app.models import NewsCollectRequest, NewsCollectResponse
from app.news import LexiconSentimentScorer, build_news_providers
from app.news.collection import collect_news
from app.news.entities import InstrumentRef

router = APIRouter(
    prefix="/news",
    tags=["news"],
    dependencies=[Depends(require_internal_key)],
)


@router.post("/collect", response_model=NewsCollectResponse)
async def collect(payload: NewsCollectRequest, settings: SettingsDep) -> NewsCollectResponse:
    instruments = [
        InstrumentRef(
            symbol=item.symbol.upper(),
            name=item.name,
            asset_class=item.asset_class,
            instrument_id=item.instrument_id,
        )
        for item in payload.instruments
    ]
    # Built per request, like the LLM: a provider that cannot be built must fail
    # this run and be recorded as failed, not take the service down at boot.
    providers = build_news_providers(settings)
    with get_engine().begin() as connection:
        stats = await collect_news(
            connection,
            providers,
            LexiconSentimentScorer(),
            instruments,
            lookback=timedelta(hours=payload.lookback_hours),
        )
    return NewsCollectResponse(**stats)
