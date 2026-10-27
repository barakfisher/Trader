"""Symbol search for the add-holding form (D324): the first provider that has a
search answers, a broken or search-less one is passed over, and an answer is
cached for SYMBOL_SEARCH_TTL_SECONDS so a repeated query costs Yahoo nothing."""

from __future__ import annotations

import time

from app.core.cache import Cache
from app.core.ratelimit import RateLimiter
from app.models import SymbolMatch
from app.providers.base import ProviderError
from app.providers.registry import (
    SYMBOL_SEARCH_LIMIT,
    SYMBOL_SEARCH_TTL_SECONDS,
    MarketDataService,
)
from tests.fakes import FakeRedis


class _NoSearch:
    name = "nosearch"
    makes_external_requests = False


class _Broken:
    name = "broken"
    makes_external_requests = False

    async def search_symbols(self, query: str, limit: int) -> list[SymbolMatch]:
        raise ProviderError("broken", "search moved")


class _Counting:
    name = "counting"
    makes_external_requests = False

    def __init__(self, matches: list[SymbolMatch]) -> None:
        self.matches = matches
        self.calls: list[tuple[str, int]] = []

    async def search_symbols(self, query: str, limit: int) -> list[SymbolMatch]:
        self.calls.append((query, limit))
        return self.matches


def _service(settings, providers, redis=None) -> MarketDataService:
    redis = redis or FakeRedis()
    return MarketDataService(providers, Cache(redis), RateLimiter(redis), settings)


async def test_the_fixture_finds_by_symbol_prefix_before_name(fixture_provider):
    matches = await fixture_provider.search_symbols("aa", SYMBOL_SEARCH_LIMIT)
    assert matches and matches[0].symbol == "AAPL"
    by_name = await fixture_provider.search_symbols("apple", SYMBOL_SEARCH_LIMIT)
    assert [match.symbol for match in by_name] == ["AAPL"]


async def test_a_provider_without_search_is_passed_over_and_a_broken_one_survived(
    settings, fixture_provider
):
    service = _service(settings, [_NoSearch(), _Broken(), fixture_provider])
    assert [m.symbol for m in await service.search_symbols("AAPL")] == ["AAPL"]


async def test_the_query_is_normalised_and_asked_with_the_limit(settings):
    provider = _Counting([SymbolMatch(symbol="TEVA", source="counting")])
    service = _service(settings, [provider])
    await service.search_symbols("  Teva  ")
    assert provider.calls == [("teva", SYMBOL_SEARCH_LIMIT)]


async def test_an_answer_is_served_from_cache_for_its_ttl(settings):
    provider = _Counting([SymbolMatch(symbol="TEVA", source="counting")])
    redis = FakeRedis()
    service = _service(settings, [provider], redis)
    first = await service.search_symbols("teva")
    again = await service.search_symbols("TEVA")
    assert again == first
    assert len(provider.calls) == 1
    key = next(key for key in redis._store if "symbol_search:teva" in key)  # noqa: SLF001
    _, expires_at = redis._store[key]  # noqa: SLF001
    assert abs((expires_at - time.time()) - SYMBOL_SEARCH_TTL_SECONDS) < 5


async def test_an_empty_answer_is_cached_but_a_failure_is_not(settings):
    nothing = _Counting([])
    service = _service(settings, [nothing])
    assert await service.search_symbols("zzzz") == []
    assert await service.search_symbols("zzzz") == []
    assert len(nothing.calls) == 1

    redis = FakeRedis()
    assert await _service(settings, [_Broken()], redis).search_symbols("zzzz") == []
    assert not any("symbol_search" in key for key in redis._store)  # noqa: SLF001


async def test_a_failure_behind_an_empty_answer_is_not_cached_as_none(settings):
    # The first preview: Yahoo timed out cold, the fixture said "none", and "teva"
    # was cached empty for a day. The next ask must reach the provider again.
    redis = FakeRedis()
    later = _Counting([SymbolMatch(symbol="TEVA", source="counting")])
    assert await _service(settings, [_Broken(), _Counting([])], redis).search_symbols("teva") == []
    found = await _service(settings, [later], redis).search_symbols("teva")
    assert [match.symbol for match in found] == ["TEVA"]


async def test_a_blank_query_asks_nobody(settings):
    provider = _Counting([SymbolMatch(symbol="X", source="counting")])
    assert await _service(settings, [provider]).search_symbols("   ") == []
    assert provider.calls == []
