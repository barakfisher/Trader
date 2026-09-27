"""The GDELT provider, driven through httpx.MockTransport: no test reaches the network.

The response bodies are shaped on live replies, including the one that matters
most - the throttle notice, which is prose with a 429, not JSON.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.news.base import NewsProviderError
from app.news.gdelt import (
    GDELT_MIN_INTERVAL_SECONDS,
    GDELT_TERMS_PER_REQUEST,
    GdeltNewsProvider,
    query_terms,
)

NOW = datetime(2026, 9, 27, 12, 0, tzinfo=UTC)
SINCE = NOW - timedelta(hours=48)

THROTTLED = (
    "Please limit requests to one every 5 seconds or contact kalev.leetaru5@gmail.com "
    "for larger queries."
)


def _article(title: str, seen: str = "20260927T101500Z", url: str | None = None) -> dict:
    return {
        "url": url or f"https://news.example.com/{abs(hash(title))}",
        "url_mobile": "",
        "title": title,
        "seendate": seen,
        "socialimage": "",
        "domain": "news.example.com",
        "language": "English",
        "sourcecountry": "United States",
    }


class Recorder:
    """A transport that answers from a queue and remembers every request."""

    def __init__(self, *responses: httpx.Response) -> None:
        self._responses = list(responses)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self._responses.pop(0)


def _provider(recorder: Recorder, sleeps: list[float] | None = None) -> GdeltNewsProvider:
    async def sleep(seconds: float) -> None:
        if sleeps is not None:
            sleeps.append(seconds)

    return GdeltNewsProvider(
        transport=httpx.MockTransport(recorder), sleep=sleep, clock=lambda: NOW
    )


NAMES = {"VLO": ["Valero Energy", "Valero"], "CCJ": ["Cameco"], "AAPL": ["Apple"]}


async def test_the_query_is_built_from_the_names_the_matcher_accepts():
    recorder = Recorder(httpx.Response(200, json={"articles": []}))

    await _provider(recorder).fetch_for_symbols(["VLO", "CCJ"], SINCE, names=NAMES)

    params = recorder.requests[0].url.params
    assert params["query"] == '("Valero" OR "Cameco") sourcelang:english'
    assert params["mode"] == "ArtList" and params["format"] == "json"
    assert params["timespan"] == "48h"


async def test_a_headline_becomes_an_article_dated_by_when_gdelt_saw_it():
    recorder = Recorder(
        httpx.Response(200, json={"articles": [_article("Valero lifts refinery runs")]})
    )

    (article,) = await _provider(recorder).fetch_for_symbols(["VLO"], SINCE, names=NAMES)

    assert article.title == article.body == "Valero lifts refinery runs"
    assert article.source == "news.example.com"
    assert article.published_at == datetime(2026, 9, 27, 10, 15, tzinfo=UTC)


async def test_the_throttle_notice_is_a_provider_failure_not_an_empty_feed():
    recorder = Recorder(httpx.Response(429, text=THROTTLED))

    with pytest.raises(NewsProviderError, match="429"):
        await _provider(recorder).fetch_for_symbols(["VLO"], SINCE, names=NAMES)


async def test_prose_with_a_200_is_still_a_failure():
    recorder = Recorder(httpx.Response(200, text=THROTTLED))

    with pytest.raises(NewsProviderError):
        await _provider(recorder).fetch_for_symbols(["VLO"], SINCE, names=NAMES)


async def test_an_empty_object_is_no_news_rather_than_an_error():
    recorder = Recorder(httpx.Response(200, json={}))

    assert await _provider(recorder).fetch_for_symbols(["VLO"], SINCE, names=NAMES) == []


async def test_many_instruments_are_split_across_requests_spaced_to_the_limit():
    symbols = [f"S{index}" for index in range(GDELT_TERMS_PER_REQUEST + 1)]
    names = {symbol: [f"Company {symbol}"] for symbol in symbols}
    recorder = Recorder(
        httpx.Response(200, json={"articles": []}), httpx.Response(200, json={"articles": []})
    )
    sleeps: list[float] = []

    await _provider(recorder, sleeps).fetch_for_symbols(symbols, SINCE, names=names)

    assert len(recorder.requests) == 2
    assert len(sleeps) == 1
    assert 0 < sleeps[0] <= GDELT_MIN_INTERVAL_SECONDS


async def test_articles_older_than_the_window_are_dropped():
    recorder = Recorder(
        httpx.Response(
            200,
            json={
                "articles": [
                    _article("Cameco fresh", seen="20260927T090000Z"),
                    _article("Cameco stale", seen="20260920T090000Z"),
                ]
            },
        )
    )

    articles = await _provider(recorder).fetch_for_symbols(["CCJ"], SINCE, names=NAMES)

    assert [article.title for article in articles] == ["Cameco fresh"]


async def test_a_symbol_with_no_name_is_not_searched():
    recorder = Recorder()

    assert await _provider(recorder).fetch_for_symbols(["XYZ"], SINCE, names={}) == []
    assert recorder.requests == []


def test_query_terms_are_the_shortest_alias_deduplicated_and_never_too_short():
    names = {"A": ["Valero Energy", "Valero"], "B": ["valero"], "C": ["3M"], "D": []}
    assert query_terms(["A", "B", "C", "D"], names) == ["Valero"]
