"""A symbol's news fetched when an agent asks for it, at most hourly (D57).

The collection run only gathers news for what the user follows, so an agent
looking at one of the day's movers found none and, by its persona, did nothing
(every one of the measured scans, 2026-10-07). Here, when an agent's `get_news`
names a symbol, its recent headlines are fetched from the on-demand provider
(`yahoo.py`) unless anyone fetched that symbol within `ON_DEMAND_INTERVAL` -
three agents at the same pre-open scan cause one request, and a scan in the
afternoon gets the afternoon's headlines.

**The same pipeline as the collection run** (`collect_news`, for one
instrument): deduped by content, linked to the instrument only when the headline
names it (`entities.py`), scored, stored. So what an agent reads is an ordinary
stored article - every agent reads the same rows, and the holding's page shows
them too when the user holds it.

**The hourly mark is claimed before the fetch**, in Redis with an expiry
(`SET NX EX`): the first caller in the hour fetches and the rest read. A fetch
that fails gives the mark back, so the next caller tries again rather than the
symbol going an hour without news. Without Redis (a test, a bare checkout) the
marks are this process's own.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from sqlalchemy.engine import Engine

from app.config import Settings
from app.core.logging import get_logger
from app.news.base import NewsProvider
from app.news.collection import collect_news
from app.news.entities import InstrumentRef
from app.news.fixture import FixtureNewsProvider
from app.news.sentiment import LexiconSentimentScorer
from app.news.yahoo import YahooNewsProvider

log = get_logger("news.on_demand")

#: How long one symbol's fetch serves every agent before the next is made.
ON_DEMAND_INTERVAL = timedelta(hours=1)
#: How far back a fetch stores: the longest window `get_news` may ask for.
ON_DEMAND_LOOKBACK = timedelta(days=7)

_KEY = "news:on_demand:{symbol}"


class FetchMarks(Protocol):
    async def claim(self, key: str, ttl: timedelta) -> bool: ...

    async def release(self, key: str) -> None: ...


class RedisFetchMarks:
    """Marks shared by every replica of the service: one fetch per symbol per hour."""

    def __init__(self, redis: Any) -> None:
        self._redis = redis

    async def claim(self, key: str, ttl: timedelta) -> bool:
        return bool(await self._redis.set(key, "1", nx=True, ex=int(ttl.total_seconds())))

    async def release(self, key: str) -> None:
        await self._redis.delete(key)


@dataclass
class MemoryFetchMarks:
    """This process's own marks, for tests and a service running without Redis."""

    clock: Callable[[], float] = time.monotonic
    _until: dict[str, float] = field(default_factory=dict)

    async def claim(self, key: str, ttl: timedelta) -> bool:
        now = self.clock()
        if self._until.get(key, 0.0) > now:
            return False
        self._until[key] = now + ttl.total_seconds()
        return True

    async def release(self, key: str) -> None:
        self._until.pop(key, None)


@dataclass(frozen=True)
class NewsOnDemand:
    """What `get_news` needs to fetch before it reads: a provider, the marks, the database."""

    engine: Engine
    provider: NewsProvider
    marks: FetchMarks

    async def refresh(
        self, instrument: InstrumentRef, now: datetime | None = None
    ) -> dict[str, Any]:
        """Fetch and store `instrument`'s news unless it was fetched this hour. Never raises."""
        key = _KEY.format(symbol=instrument.symbol)
        if not await self.marks.claim(key, ON_DEMAND_INTERVAL):
            return {"fetched": False}
        moment = now or datetime.now(UTC)
        try:
            with self.engine.begin() as connection:
                stats = await collect_news(
                    connection,
                    [self.provider],
                    LexiconSentimentScorer(),
                    [instrument],
                    lookback=ON_DEMAND_LOOKBACK,
                    now=moment,
                )
        except Exception as error:  # noqa: BLE001 - news is a nicety; the scan goes on
            await self.marks.release(key)
            log.warning("news.on_demand.failed", symbol=instrument.symbol, error=str(error))
            return {"fetched": False, "error": type(error).__name__}
        failed = bool(stats.get("provider_failures"))
        if failed:
            await self.marks.release(key)
        log.info(
            "news.on_demand.fetched",
            symbol=instrument.symbol,
            inserted=stats.get("inserted"),
            linked=stats.get("linked_symbols"),
        )
        return {"fetched": not failed, "inserted": stats.get("inserted", 0)}


#: Marks for a service with no Redis: one set per process, so they still hold across scans.
_PROCESS_MARKS = MemoryFetchMarks()


def news_on_demand(settings: Settings, engine: Engine, redis: Any | None) -> NewsOnDemand | None:
    """The configured on-demand news, or None when it is switched off."""
    provider: NewsProvider
    if settings.agent_news_provider == "off":
        return None
    if settings.agent_news_provider == "fixture":
        provider = FixtureNewsProvider(settings.fixtures_dir)
    else:
        provider = YahooNewsProvider()
    marks: FetchMarks = RedisFetchMarks(redis) if redis is not None else _PROCESS_MARKS
    return NewsOnDemand(engine=engine, provider=provider, marks=marks)
