"""The day's movers for an agent's briefing (D15): from the first provider that
publishes a list, cached for the slot, and never invented when none does."""

from __future__ import annotations

from app.core.cache import Cache
from app.core.ratelimit import RateLimiter
from app.models import Mover
from app.providers.base import ProviderError
from app.providers.registry import MarketDataService
from tests.fakes import FakeRedis


async def test_the_fixture_lists_its_own_rises_and_falls(fixture_provider):
    movers = await fixture_provider.movers()
    quotes = {q.symbol: q for q in await fixture_provider.quotes([m.symbol for m in movers])}
    assert movers, "the fixture has instruments that moved"
    for mover in movers:
        assert mover.change_pct == quotes[mover.symbol].day_change_pct
        assert (mover.list == "gainers") == (mover.change_pct > 0)


class _NoList:
    name = "nolist"
    makes_external_requests = False


class _Broken:
    name = "broken"
    makes_external_requests = False

    async def movers(self) -> list[Mover]:
        raise ProviderError("broken", "screener moved")


def _service(settings, providers) -> MarketDataService:
    redis = FakeRedis()
    return MarketDataService(providers, Cache(redis), RateLimiter(redis), settings)


async def test_a_provider_without_a_list_is_passed_over_and_a_broken_one_survived(
    settings, fixture_provider
):
    service = _service(settings, [_NoList(), _Broken(), fixture_provider])
    assert await service.movers() == await fixture_provider.movers()


async def test_the_list_is_fetched_once_per_cache_period(settings, fixture_provider, monkeypatch):
    service = _service(settings, [fixture_provider])
    first = await service.movers()

    async def explode():
        raise AssertionError("served from cache within the period")

    monkeypatch.setattr(fixture_provider, "movers", explode)
    assert await service.movers() == first


async def test_no_list_anywhere_is_an_empty_answer(settings):
    assert await _service(settings, [_NoList(), _Broken()]).movers() == []
