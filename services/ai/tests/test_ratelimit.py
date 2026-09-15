from datetime import UTC, datetime

import pytest

from app.config import Settings
from app.core.cache import Cache
from app.core.ratelimit import RateLimiter
from app.providers.registry import MarketDataService
from tests.fakes import FakeRedis


@pytest.fixture
def limiter() -> RateLimiter:
    return RateLimiter(FakeRedis())


# -- per-minute window --------------------------------------------------------


async def test_a_call_costs_one_by_default(limiter: RateLimiter):
    for _ in range(3):
        assert await limiter.allow("yfinance", 3) is True
    assert await limiter.allow("yfinance", 3) is False


async def test_cost_is_charged_in_full(limiter: RateLimiter):
    # The bug this fixes: ten upstream requests used to cost one token.
    assert await limiter.allow("yfinance", 25, cost=10) is True
    assert await limiter.allow("yfinance", 25, cost=10) is True
    assert await limiter.allow("yfinance", 25, cost=10) is False


async def test_a_single_oversized_call_is_denied(limiter: RateLimiter):
    assert await limiter.allow("yfinance", 5, cost=200) is False


async def test_budgets_are_per_provider(limiter: RateLimiter):
    assert await limiter.allow("yfinance", 1, cost=1) is True
    assert await limiter.allow("yfinance", 1, cost=1) is False
    assert await limiter.allow("alphavantage", 1, cost=1) is True


async def test_a_new_minute_is_a_new_window(limiter: RateLimiter, monkeypatch):
    clock = {"now": 1_800_000_000.0}
    monkeypatch.setattr("app.core.ratelimit.time.time", lambda: clock["now"])
    assert await limiter.allow("yfinance", 1) is True
    assert await limiter.allow("yfinance", 1) is False
    clock["now"] += 60
    assert await limiter.allow("yfinance", 1) is True


async def test_a_limit_of_zero_means_unlimited(limiter: RateLimiter):
    assert await limiter.allow("yfinance", 0, cost=10_000) is True


async def test_a_zero_cost_call_is_never_charged(limiter: RateLimiter):
    assert await limiter.allow("yfinance", 1, cost=0) is True
    assert await limiter.allow("yfinance", 1, cost=1) is True


# -- daily budget -------------------------------------------------------------


async def test_the_daily_budget_stops_a_free_tier_being_burned(limiter: RateLimiter):
    # Alpha Vantage's free tier is 25 requests a day, which 60/minute cannot protect.
    assert await limiter.allow_daily("alphavantage", 25, cost=10) is True
    assert await limiter.allow_daily("alphavantage", 25, cost=10) is True
    assert await limiter.allow_daily("alphavantage", 25, cost=10) is False


async def test_the_daily_budget_survives_the_minute_window(limiter: RateLimiter, monkeypatch):
    clock = {"now": 1_800_000_000.0}
    monkeypatch.setattr("app.core.ratelimit.time.time", lambda: clock["now"])
    assert await limiter.allow_daily("alphavantage", 2, cost=2) is True
    clock["now"] += 3600
    assert await limiter.allow_daily("alphavantage", 2, cost=1) is False


async def test_the_daily_budget_rolls_over_at_utc_midnight(limiter: RateLimiter, monkeypatch):
    day = {"value": datetime(2026, 9, 15, 23, 59, tzinfo=UTC)}

    class FrozenDatetime:
        @staticmethod
        def now(tz=None):
            return day["value"]

    monkeypatch.setattr("app.core.ratelimit.datetime", FrozenDatetime)
    assert await limiter.allow_daily("alphavantage", 1) is True
    assert await limiter.allow_daily("alphavantage", 1) is False

    day["value"] = datetime(2026, 9, 16, 0, 1, tzinfo=UTC)
    assert await limiter.allow_daily("alphavantage", 1) is True


async def test_no_configured_cap_means_no_daily_limit(limiter: RateLimiter):
    assert await limiter.allow_daily("yfinance", 0, cost=10_000) is True


# -- configuration ------------------------------------------------------------


def test_daily_limits_are_parsed_from_the_flat_string():
    settings = Settings(app_env="test", provider_daily_limits="alphavantage=25, finnhub=60")
    assert settings.provider_daily_limit_map == {"alphavantage": 25, "finnhub": 60}


def test_an_empty_setting_means_no_caps():
    assert Settings(app_env="test").provider_daily_limit_map == {}


@pytest.mark.parametrize("raw", ["alphavantage", "alphavantage=lots", "=25"])
def test_a_malformed_entry_fails_at_boot(raw):
    # Silently dropping it would read as "this provider has no cap", which is the
    # failure the setting exists to prevent.
    with pytest.raises(ValueError):
        Settings(app_env="test", provider_daily_limits=raw)


# -- wiring -------------------------------------------------------------------


class _RecordingLimiter(RateLimiter):
    """Remembers what it was charged instead of guessing from Redis state."""

    def __init__(self) -> None:
        super().__init__(FakeRedis())
        self.minute_charges: list[tuple[str, int]] = []
        self.daily_charges: list[tuple[str, int, int]] = []
        self.deny_daily_for: set[str] = set()

    async def allow(self, provider: str, limit_per_minute: int, cost: int = 1) -> bool:
        self.minute_charges.append((provider, cost))
        return await super().allow(provider, limit_per_minute, cost)

    async def allow_daily(self, provider: str, limit_per_day: int, cost: int = 1) -> bool:
        self.daily_charges.append((provider, limit_per_day, cost))
        if provider in self.deny_daily_for:
            return False
        return await super().allow_daily(provider, limit_per_day, cost)


class _ExternalProvider:
    """One upstream request per symbol, like yfinance."""

    name = "external"
    delay_seconds = 900
    quote_granularity_seconds = 900
    makes_external_requests = True
    batches_requests = False

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    async def quotes(self, symbols):
        from app.models import Quote

        self.calls.append(list(symbols))
        return [
            Quote(
                symbol=symbol,
                price_minor=10_000,
                currency="USD",
                as_of=datetime(2026, 9, 15, 15, 0, tzinfo=UTC),
                source=self.name,
                delay_seconds=self.delay_seconds,
            )
            for symbol in symbols
        ]

    async def resolve(self, query):  # pragma: no cover - not exercised here
        raise NotImplementedError

    async def fx_rate(self, base, quote):  # pragma: no cover - not exercised here
        return None


class _BatchingProvider(_ExternalProvider):
    """One upstream request for the whole list, like Polygon's snapshot."""

    name = "batching"
    batches_requests = True


def _service(providers, settings, limiter):
    redis = FakeRedis()
    return MarketDataService(providers, Cache(redis), limiter, settings)


async def test_ten_symbols_against_a_per_symbol_provider_cost_ten(settings):
    limiter = _RecordingLimiter()
    symbols = [f"SYM{i}" for i in range(10)]
    await _service([_ExternalProvider()], settings, limiter).quotes(symbols)
    assert limiter.minute_charges == [("external", 10)]


async def test_a_batching_provider_costs_one(settings):
    limiter = _RecordingLimiter()
    symbols = [f"SYM{i}" for i in range(10)]
    await _service([_BatchingProvider()], settings, limiter).quotes(symbols)
    assert limiter.minute_charges == [("batching", 1)]


async def test_a_local_provider_skips_the_limiter(settings, fixture_provider):
    limiter = _RecordingLimiter()
    quotes, _ = await _service([fixture_provider], settings, limiter).quotes(["AAPL", "VOO"])
    assert [q.symbol for q in quotes] == ["AAPL", "VOO"]
    assert limiter.minute_charges == []
    assert limiter.daily_charges == []


async def test_the_configured_daily_cap_reaches_the_limiter(fixture_provider):
    limiter = _RecordingLimiter()
    settings = Settings(
        app_env="test",
        market_data_providers="external",
        provider_daily_limits="external=25",
    )
    await _service([_ExternalProvider()], settings, limiter).quotes(["AAPL", "VOO"])
    assert limiter.daily_charges == [("external", 25, 2)]


async def test_an_over_budget_provider_is_skipped_and_the_chain_continues(
    settings, fixture_provider
):
    limiter = _RecordingLimiter()
    limiter.deny_daily_for = {"external"}
    blocked = _ExternalProvider()
    quotes, missing = await _service([blocked, fixture_provider], settings, limiter).quotes(
        ["AAPL"]
    )

    assert blocked.calls == []  # never called, so no quota was spent
    assert [q.source for q in quotes] == ["fixture"]
    assert missing == []
    # The per-minute window is not charged for a call the daily budget refused.
    assert limiter.minute_charges == []
