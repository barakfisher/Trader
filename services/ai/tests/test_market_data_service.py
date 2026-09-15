from app.models import Quote
from app.providers.base import ProviderError
from app.providers.registry import MarketDataService


async def test_deduplicates_and_preserves_request_order(market_data: MarketDataService):
    quotes, missing = await market_data.quotes(["voo", "AAPL", "VOO"])
    assert [q.symbol for q in quotes] == ["VOO", "AAPL"]
    assert missing == []


async def test_unpriceable_symbols_are_reported_not_hidden(market_data: MarketDataService):
    quotes, missing = await market_data.quotes(["AAPL", "FAKE1"])
    assert [q.symbol for q in quotes] == ["AAPL"]
    assert missing == ["FAKE1"]


async def test_second_call_is_served_from_cache(market_data: MarketDataService, monkeypatch):
    await market_data.quotes(["AAPL"])

    async def explode(_symbols):
        raise AssertionError("provider must not be called again within the quote TTL")

    monkeypatch.setattr(market_data._providers[0], "quotes", explode)
    quotes, _ = await market_data.quotes(["AAPL"])
    assert quotes[0].symbol == "AAPL"


async def test_falls_back_to_last_known_value_marked_stale(
    market_data: MarketDataService, monkeypatch
):
    # Prime both cache layers, then expire the hot entry and break the provider.
    await market_data.quotes(["AAPL"])
    await market_data._cache._redis.delete("traders:quote:AAPL")

    async def outage(_symbols):
        raise ProviderError("fixture", "simulated outage")

    monkeypatch.setattr(market_data._providers[0], "quotes", outage)
    quotes, missing = await market_data.quotes(["AAPL"])
    assert missing == []
    assert isinstance(quotes[0], Quote)
    assert quotes[0].stale is True


async def test_chain_moves_on_when_first_provider_fails(settings, fixture_provider):
    from app.core.cache import Cache
    from app.core.ratelimit import RateLimiter
    from tests.fakes import FakeRedis

    class BrokenProvider:
        name = "broken"
        delay_seconds = 0
        makes_external_requests = True
        batches_requests = False

        async def quotes(self, symbols):
            raise ProviderError(self.name, "down")

        async def resolve(self, query):
            raise ProviderError(self.name, "down")

        async def fx_rate(self, base, quote):
            return None

    redis = FakeRedis()
    service = MarketDataService(
        [BrokenProvider(), fixture_provider], Cache(redis), RateLimiter(redis), settings
    )
    quotes, missing = await service.quotes(["AAPL"])
    assert quotes[0].source == "fixture"
    assert missing == []
