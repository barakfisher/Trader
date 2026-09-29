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
from app.news.queries import SqlFeedCursor

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
    with get_engine().begin() as connection:
        # Built per request, like the LLM: a provider that cannot be built must
        # fail this run and be recorded as failed, not take the service down at
        # boot. Built inside the transaction, so a feed's cursor commits or
        # rolls back with the articles it read.
        providers = build_news_providers(
            settings, cursor_for=lambda name: SqlFeedCursor(connection, name)
        )
        stats = await collect_news(
            connection,
            providers,
            LexiconSentimentScorer(),
            instruments,
            lookback=timedelta(hours=payload.lookback_hours),
            market_retention=(
                timedelta(days=payload.market_retention_days)
                if payload.market_retention_days is not None
                else None
            ),
        )
    return NewsCollectResponse(**stats)
