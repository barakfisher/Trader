"""Yahoo Finance's news search: a symbol's recent headlines, asked for one at a time.

The news an agent reads about a stock it does not follow (D57). GDELT, the
collection run's source, is a stream of 15-minute files filtered by the names
the user follows; it cannot be asked about one symbol after the fact - three
days of it is about 860 MB - and widening its filter to the universe matched
559 of 1,255 headlines in one file, on names such as "ON" and "News" (measured
2026-10-07). Yahoo answers a symbol in under a second with eight or so
headlines, its publisher and time, and no key.

**Through `yfinance.Search`**, the package the market data already uses (no
client of our own, CLAUDE.md convention 5). Its `Ticker.get_news` returned
nothing for every symbol tried the same day; `Search` returned the headlines.

**What is passed on** is what `RawArticle` holds: title, link, publisher, time.
Yahoo also lists each item's `relatedTickers`, and that is dropped on purpose,
as every provider's idea of relevance is (`base.py`): half of INTC's results
were general market stories that listed INTC among forty tickers. Which
instrument an article is about is `entities.py`'s call, by the headline.

`fetch_for_symbols` makes one request per symbol (`batches_requests = False`).
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from app.core.logging import get_logger
from app.news.article import RawArticle
from app.news.base import NewsProviderError

log = get_logger("news.yahoo")

#: Headlines asked for per symbol: about a day or two of a large company's news.
YAHOO_NEWS_COUNT = 10

#: `(query, count) -> Yahoo's news items`; a test passes a scripted one.
Search = Callable[[str, int], list[dict[str, Any]]]


def _yfinance_search(query: str, count: int) -> list[dict[str, Any]]:
    import yfinance

    return list(yfinance.Search(query, max_results=0, news_count=count).news or [])


def _to_article(item: Mapping[str, Any]) -> RawArticle | None:
    title = item.get("title")
    link = item.get("link")
    if not isinstance(title, str) or not title.strip() or not isinstance(link, str) or not link:
        return None
    stamp = item.get("providerPublishTime")
    published = (
        datetime.fromtimestamp(stamp, UTC)
        if isinstance(stamp, int | float) and not isinstance(stamp, bool)
        else None
    )
    publisher = item.get("publisher")
    return RawArticle(
        url=link,
        source=publisher if isinstance(publisher, str) and publisher else "yahoo",
        title=title.strip(),
        # The headline is the body, as with GDELT: sentiment is headline sentiment.
        body=title.strip(),
        published_at=published,
    )


class YahooNewsProvider:
    name = "yahoo"
    makes_external_requests = True
    batches_requests = False

    def __init__(self, *, search: Search | None = None, count: int = YAHOO_NEWS_COUNT) -> None:
        self._search = search or _yfinance_search
        self._count = count

    async def fetch_for_symbols(
        self,
        symbols: list[str],
        since: datetime,
        *,
        limit: int | None = None,
        names: Mapping[str, Sequence[str]] | None = None,
    ) -> list[RawArticle]:
        articles: list[RawArticle] = []
        for symbol in symbols:
            articles.extend(await self._fetch(symbol, since))
        return articles[:limit] if limit else articles

    async def fetch_for_query(
        self,
        query: str,
        since: datetime,
        *,
        limit: int | None = None,
    ) -> list[RawArticle]:
        articles = await self._fetch(query, since)
        return articles[:limit] if limit else articles

    async def _fetch(self, query: str, since: datetime) -> list[RawArticle]:
        try:
            # yfinance is synchronous; a scan's event loop must not wait on it.
            items = await asyncio.to_thread(self._search, query, self._count)
        except Exception as exc:  # noqa: BLE001 - any failure is "unusable right now"
            raise NewsProviderError(self.name, f"{query}: {exc.__class__.__name__}") from exc
        cutoff = since.astimezone(UTC)
        articles = [
            article
            for article in (_to_article(item) for item in items if isinstance(item, Mapping))
            if article is not None
            and (article.published_at is None or article.published_at >= cutoff)
        ]
        log.info("news.yahoo.fetched", query=query, items=len(items), kept=len(articles))
        return articles
