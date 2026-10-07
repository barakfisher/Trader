"""Yahoo's news search as a provider, and the hourly marks that share it (D57).

Hermetic: the search is scripted and the marks are in memory. The fetch stored
and read over real SQL is `tests/integration/test_agent_tools_sql.py`.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.config import Settings
from app.news.base import NewsProviderError
from app.news.on_demand import (
    ON_DEMAND_INTERVAL,
    MemoryFetchMarks,
    RedisFetchMarks,
    news_on_demand,
)
from app.news.yahoo import YahooNewsProvider

NOW = datetime(2026, 10, 7, 13, 0, tzinfo=UTC)


def _item(title: object, *, hours_ago: float = 1, **extra: object) -> dict[str, object]:
    return {
        "title": title,
        "link": f"https://y/{title}",
        "publisher": "Reuters",
        "providerPublishTime": int((NOW - timedelta(hours=hours_ago)).timestamp()),
        "relatedTickers": ["INTC", "NVDA"],
        **extra,
    }


async def test_a_headline_becomes_a_raw_article_and_the_vendors_tickers_are_dropped() -> None:
    provider = YahooNewsProvider(search=lambda _q, _n: [_item("Intel rallies")])
    [article] = await provider.fetch_for_symbols(["INTC"], NOW - timedelta(days=3))
    assert (article.title, article.source, article.url) == (
        "Intel rallies",
        "Reuters",
        "https://y/Intel rallies",
    )
    assert article.published_at == NOW - timedelta(hours=1)
    assert not hasattr(article, "related_tickers")


async def test_old_untitled_and_unlinked_items_are_left_out() -> None:
    items = [
        _item("Too old", hours_ago=100),
        _item(""),
        {"title": "No link"},
        _item("Kept", providerPublishTime=None),
    ]
    provider = YahooNewsProvider(search=lambda _q, _n: items)
    kept = await provider.fetch_for_symbols(["INTC"], NOW - timedelta(days=3))
    # An item with no time is kept undated, never re-dated (guideline 7).
    assert [(a.title, a.published_at) for a in kept] == [("Kept", None)]


async def test_one_request_per_symbol_and_a_failure_is_a_provider_error() -> None:
    asked: list[str] = []

    def search(query: str, _count: int) -> list[dict[str, object]]:
        asked.append(query)
        return []

    await YahooNewsProvider(search=search).fetch_for_symbols(["INTC", "NVDA"], NOW)
    assert asked == ["INTC", "NVDA"]

    def broken(_q: str, _n: int) -> list[dict[str, object]]:
        raise ConnectionError("down")

    with pytest.raises(NewsProviderError, match="yahoo"):
        await YahooNewsProvider(search=broken).fetch_for_symbols(["INTC"], NOW)


async def test_a_mark_holds_for_the_interval_and_can_be_given_back() -> None:
    clock = [0.0]
    marks = MemoryFetchMarks(clock=lambda: clock[0])
    assert await marks.claim("k", ON_DEMAND_INTERVAL)
    assert not await marks.claim("k", ON_DEMAND_INTERVAL)
    clock[0] += ON_DEMAND_INTERVAL.total_seconds() + 1
    assert await marks.claim("k", ON_DEMAND_INTERVAL)
    await marks.release("k")
    assert await marks.claim("k", ON_DEMAND_INTERVAL)


async def test_the_redis_mark_is_set_once_with_an_expiry() -> None:
    class FakeRedis:
        def __init__(self) -> None:
            self.calls: list[tuple[str, dict[str, object]]] = []
            self.held: set[str] = set()

        async def set(self, key: str, _value: str, **options: object) -> bool:
            self.calls.append((key, options))
            if key in self.held:
                return False
            self.held.add(key)
            return True

        async def delete(self, key: str) -> None:
            self.held.discard(key)

    redis = FakeRedis()
    marks = RedisFetchMarks(redis)
    assert await marks.claim("k", ON_DEMAND_INTERVAL)
    assert not await marks.claim("k", ON_DEMAND_INTERVAL)
    assert redis.calls[0][1] == {"nx": True, "ex": int(ON_DEMAND_INTERVAL.total_seconds())}


def test_off_reads_only_what_is_stored() -> None:
    settings = Settings(_env_file=None, agent_news_provider="off")  # type: ignore[call-arg]
    assert news_on_demand(settings, engine=None, redis=None) is None  # type: ignore[arg-type]
    settings = Settings(_env_file=None, agent_news_provider="yahoo")  # type: ignore[call-arg]
    built = news_on_demand(settings, engine=None, redis=None)  # type: ignore[arg-type]
    assert built is not None and built.provider.name == "yahoo"
