from datetime import UTC, datetime

import pytest

from app.core.cache_policy import (
    CLOSED_TTL_SECONDS,
    CRYPTO_TTL_SECONDS,
    is_crypto_symbol,
    is_us_market_open,
    quote_ttl,
)


#: 2026-09-15 is a Tuesday; 2026-09-19 a Saturday, 2026-09-20 a Sunday.
def weekday(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 9, 15, hour, minute, tzinfo=UTC)


def saturday(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 9, 19, hour, minute, tzinfo=UTC)


YFINANCE_DELAY = 900


# -- symbol classification ----------------------------------------------------


@pytest.mark.parametrize("symbol", ["BTC-USD", "eth-usd", "SOL-USDT", "BTC-EUR", "ETH-BTC"])
def test_pair_shaped_symbols_read_as_crypto(symbol):
    assert is_crypto_symbol(symbol) is True


@pytest.mark.parametrize("symbol", ["AAPL", "VOO", "BRK.B", "USD", "TSM"])
def test_plain_tickers_do_not(symbol):
    assert is_crypto_symbol(symbol) is False


# -- market hours -------------------------------------------------------------


def test_regular_session_is_open():
    assert is_us_market_open(weekday(15, 0)) is True


@pytest.mark.parametrize(
    ("moment", "open_"),
    [
        (weekday(13, 29), False),  # one minute before the bell
        (weekday(13, 30), True),  # the bell
        (weekday(19, 59), True),  # last minute of the session
        (weekday(20, 0), False),  # the close is exclusive
    ],
)
def test_boundary_minutes(moment, open_):
    assert is_us_market_open(moment) is open_


def test_the_market_is_closed_all_weekend():
    assert is_us_market_open(saturday(15, 0)) is False
    assert is_us_market_open(datetime(2026, 9, 20, 15, 0, tzinfo=UTC)) is False


def test_non_utc_input_is_normalised():
    from zoneinfo import ZoneInfo

    # 16:30 in Jerusalem is 13:30 UTC: the opening bell.
    jerusalem = datetime(2026, 9, 15, 16, 30, tzinfo=ZoneInfo("Asia/Jerusalem"))
    assert is_us_market_open(jerusalem) is True


# -- ttl ----------------------------------------------------------------------


def test_crypto_is_always_a_minute_open_or_closed():
    assert quote_ttl("BTC-USD", YFINANCE_DELAY, weekday(15, 0)) == CRYPTO_TTL_SECONDS
    assert quote_ttl("BTC-USD", YFINANCE_DELAY, weekday(3, 0)) == CRYPTO_TTL_SECONDS
    assert quote_ttl("BTC-USD", YFINANCE_DELAY, saturday(3, 0)) == CRYPTO_TTL_SECONDS


def test_an_equity_in_hours_is_cached_for_the_provider_delay():
    # The whole point: yfinance republishes every 15 minutes, so 14 of every 15
    # one-minute refetches were returning a value we already held.
    assert quote_ttl("AAPL", YFINANCE_DELAY, weekday(15, 0)) == YFINANCE_DELAY


def test_an_equity_out_of_hours_is_cached_for_an_hour():
    assert quote_ttl("AAPL", YFINANCE_DELAY, weekday(3, 0)) == CLOSED_TTL_SECONDS
    assert quote_ttl("AAPL", YFINANCE_DELAY, saturday(15, 0)) == CLOSED_TTL_SECONDS


def test_the_configured_minimum_is_a_floor():
    # A provider that declares no delay must not turn the hot path into a poll.
    assert quote_ttl("AAPL", 0, weekday(15, 0), minimum_ttl_seconds=60) == 60
    assert quote_ttl("AAPL", 0, weekday(15, 0), minimum_ttl_seconds=300) == 300
    # And a floor above the closed-market TTL still wins.
    assert quote_ttl("AAPL", 0, weekday(3, 0), minimum_ttl_seconds=7200) == 7200
    # The floor has to exceed the crypto TTL to be the binding constraint.
    assert quote_ttl("BTC-USD", 0, weekday(3, 0), minimum_ttl_seconds=600) == 600


def test_the_floor_never_shortens_a_longer_provider_delay():
    assert quote_ttl("AAPL", YFINANCE_DELAY, weekday(15, 0), minimum_ttl_seconds=60) == 900


def test_now_defaults_to_the_current_time():
    # Only that it is one of the three legal answers; asserting which one would
    # make the suite depend on when CI runs.
    assert quote_ttl("AAPL", YFINANCE_DELAY) in {YFINANCE_DELAY, CLOSED_TTL_SECONDS}


# -- wiring -------------------------------------------------------------------


class _DelayedProvider:
    """Stands in for yfinance: declares a 15-minute delay, needs no network."""

    name = "delayed"
    delay_seconds = 900
    quote_granularity_seconds = 900
    makes_external_requests = True
    batches_requests = False

    async def quotes(self, symbols):
        from app.models import Quote

        return [
            Quote(
                symbol=symbol,
                price_minor=10_000,
                currency="USD",
                as_of=weekday(15, 0),
                source=self.name,
                delay_seconds=self.delay_seconds,
            )
            for symbol in symbols
        ]

    async def resolve(self, query):  # pragma: no cover - not exercised here
        raise NotImplementedError

    async def fx_rate(self, base, quote):  # pragma: no cover - not exercised here
        return None


def _service_with_recording_cache(settings):
    """A MarketDataService whose cache remembers the TTL it was handed."""
    from app.core.cache import Cache
    from app.core.ratelimit import RateLimiter
    from app.providers.registry import MarketDataService
    from tests.fakes import FakeRedis

    redis = FakeRedis()
    cache = Cache(redis)
    recorded: dict[str, int] = {}
    original_set = cache.set

    async def recording_set(key, value, ttl_seconds):
        recorded[key] = ttl_seconds
        await original_set(key, value, ttl_seconds)

    cache.set = recording_set  # type: ignore[method-assign]
    service = MarketDataService([_DelayedProvider()], cache, RateLimiter(redis), settings)
    return service, recorded


async def test_registry_caches_a_quote_for_the_policy_ttl(settings, monkeypatch):
    # Force the market open so the assertion does not depend on whether the
    # suite happens to run during US trading hours.
    import app.core.cache_policy as policy

    monkeypatch.setattr(policy, "is_us_market_open", lambda _now: True)
    service, recorded = _service_with_recording_cache(settings)

    await service.quotes(["AAPL", "BTC-USD"])

    # The provider's delay for the equity, a minute for the crypto pair - not the
    # flat CACHE_TTL_QUOTE both used to get.
    assert recorded["quote:AAPL"] == 900
    assert recorded["quote:BTC-USD"] == CRYPTO_TTL_SECONDS
    # The last-known-good layer is untouched by the policy.
    assert recorded["quote:last:AAPL"] == 7 * 24 * 3600


async def test_registry_passes_the_configured_floor_to_the_policy(settings, monkeypatch):
    seen: list[tuple] = []

    def fake_policy(symbol, provider_delay_seconds, now=None, *, minimum_ttl_seconds):
        seen.append((symbol, provider_delay_seconds, minimum_ttl_seconds))
        return 4242

    monkeypatch.setattr("app.providers.registry.quote_ttl", fake_policy)
    service, recorded = _service_with_recording_cache(settings)

    await service.quotes(["AAPL"])

    assert seen == [("AAPL", 900, settings.cache_ttl_quote)]
    assert recorded["quote:AAPL"] == 4242


def test_crypto_ttl_stays_within_free_tier_reach():
    """A floor, not an exact value, so tuning does not churn the suite.

    Crypto is the most expensive symbol class we serve: it never closes, so its
    TTL alone decides the request rate. Anything under five minutes puts a
    single open dashboard past what free provider tiers tolerate, so that is the
    line worth defending in a test rather than in a comment someone edits away.
    """
    assert CRYPTO_TTL_SECONDS >= 300
    assert quote_ttl("ETH-USD", YFINANCE_DELAY, weekday(15, 0)) >= 300


def test_crypto_still_refreshes_far_more_often_than_a_closed_market():
    # The point of the crypto branch is that continuous markets must not inherit
    # the closed-market TTL; raising the floor must not blur that distinction.
    assert quote_ttl("BTC-USD", YFINANCE_DELAY, weekday(3, 0)) < quote_ttl(
        "AAPL", YFINANCE_DELAY, weekday(3, 0)
    )
