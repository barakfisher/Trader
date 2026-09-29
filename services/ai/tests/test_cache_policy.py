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


# -- the instrument's own market ----------------------------------------------


class TestTheInstrumentsOwnMarket:
    """SAP.DE trades 09:00-17:30 in Frankfurt; judged by New York it was wrong
    in both directions every weekday."""

    def test_a_frankfurt_morning_is_open_on_xetra_and_closed_in_new_york(self):
        # 08:00 UTC in September is 10:00 in Frankfurt and 04:00 in New York.
        moment = weekday(8, 0)
        assert quote_ttl("SAP.DE", YFINANCE_DELAY, moment, exchange="XETRA") == YFINANCE_DELAY
        assert quote_ttl("SAP.DE", YFINANCE_DELAY, moment) == CLOSED_TTL_SECONDS

    def test_after_the_frankfurt_close_xetra_is_closed_while_new_york_trades(self):
        # 16:00 UTC is 18:00 in Frankfurt (closed at 17:30) and 12:00 in New York.
        moment = weekday(16, 0)
        assert quote_ttl("SAP.DE", YFINANCE_DELAY, moment, exchange="XETRA") == CLOSED_TTL_SECONDS
        assert quote_ttl("SAP.DE", YFINANCE_DELAY, moment) == YFINANCE_DELAY

    @pytest.mark.parametrize("pair", [("NASDAQ", "NMS"), ("NYSE", "NYQ"), ("NYSEARCA", "PCX"),
                                      ("XETRA", "GER")])  # fmt: skip
    def test_display_names_and_yahoo_codes_are_the_same_session(self, pair):
        from app.core.market_sessions import session_for

        assert session_for(pair[0]) == session_for(pair[1])

    def test_an_unknown_exchange_keeps_new_york_hours(self):
        from app.core.market_sessions import US, session_for

        assert session_for("SOMEWHERE") == US
        assert session_for(None) == US
        assert quote_ttl("X", YFINANCE_DELAY, weekday(15, 0), exchange="SOMEWHERE") == (
            YFINANCE_DELAY
        )

    def test_the_asset_class_decides_crypto_when_it_is_known(self):
        closed = weekday(3, 0)
        # No pair suffix, but the instruments table says crypto.
        assert quote_ttl("BTC", YFINANCE_DELAY, closed, asset_class="crypto") == CRYPTO_TTL_SECONDS
        # A pair-shaped symbol the table says is an equity is judged as one.
        assert quote_ttl("ABC-USD", YFINANCE_DELAY, closed, asset_class="equity") == (
            CLOSED_TTL_SECONDS
        )
        # `unknown` knows nothing, so the shape decides, as before.
        assert quote_ttl("BTC-USD", YFINANCE_DELAY, closed, asset_class="unknown") == (
            CRYPTO_TTL_SECONDS
        )

    def test_frankfurt_and_new_york_change_clocks_on_different_weekends(self):
        from app.core.cache_policy import is_session_open
        from app.core.market_sessions import FRANKFURT

        # 2026-03-09 (Mon): New York is on summer time, Frankfurt is not until
        # 2026-03-29. 08:30 UTC is 09:30 in Frankfurt - open - whichever
        # weekend New York moved.
        assert is_session_open(datetime(2026, 3, 9, 8, 30, tzinfo=UTC), FRANKFURT) is True
        # 16:45 UTC that day is 17:45 in Frankfurt: closed.
        assert is_session_open(datetime(2026, 3, 9, 16, 45, tzinfo=UTC), FRANKFURT) is False


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
    # suite happens to run during trading hours. Patch the function `quote_ttl`
    # calls: this patched `is_us_market_open` until #77 routed the check through
    # `is_session_open`, after which the test quietly read the real clock and
    # failed on `main` the first time CI ran outside US hours.
    import app.core.cache_policy as policy

    monkeypatch.setattr(policy, "is_session_open", lambda _now, _session: True)
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

    def fake_policy(
        symbol, provider_delay_seconds, now=None, *, minimum_ttl_seconds, asset_class, exchange
    ):
        seen.append((symbol, provider_delay_seconds, minimum_ttl_seconds, asset_class, exchange))
        return 4242

    monkeypatch.setattr("app.providers.registry.quote_ttl", fake_policy)
    service, recorded = _service_with_recording_cache(settings)

    await service.quotes(["AAPL"])

    assert seen == [("AAPL", 900, settings.cache_ttl_quote, None, None)]
    assert recorded["quote:AAPL"] == 4242


async def test_registry_passes_each_symbols_market_to_the_policy(settings, monkeypatch):
    from app.models import QuoteMarket

    seen: dict[str, tuple] = {}

    def fake_policy(symbol, _delay, now=None, *, minimum_ttl_seconds, asset_class, exchange):
        seen[symbol] = (asset_class, exchange)
        return 60

    monkeypatch.setattr("app.providers.registry.quote_ttl", fake_policy)
    service, _ = _service_with_recording_cache(settings)

    # Keys are matched case-insensitively, like the symbols themselves.
    await service.quotes(
        ["SAP.DE", "AAPL"], {"sap.de": QuoteMarket(asset_class="equity", exchange="XETRA")}
    )

    assert seen == {"SAP.DE": ("equity", "XETRA"), "AAPL": (None, None)}


class TestDaylightSaving:
    """The session is a New York local time, not a fixed UTC window.

    A hardcoded summer window treats 20:00-21:00 UTC as closed all winter - the
    final hour of an active trading day - and would serve hour-old prices
    through it. These cases would fail against such a window.
    """

    def test_winter_afternoon_is_open(self):
        # 20:30 UTC in January is 15:30 in New York: half an hour before the bell.
        assert is_us_market_open(datetime(2026, 1, 15, 20, 30, tzinfo=UTC)) is True

    def test_winter_early_morning_is_closed(self):
        # 13:45 UTC in January is 08:45 in New York: before the open.
        assert is_us_market_open(datetime(2026, 1, 15, 13, 45, tzinfo=UTC)) is False

    def test_summer_afternoon_is_closed(self):
        # The same 20:30 UTC in July is 16:30 in New York: after the close.
        assert is_us_market_open(datetime(2026, 7, 15, 20, 30, tzinfo=UTC)) is False

    def test_summer_morning_is_open(self):
        assert is_us_market_open(datetime(2026, 7, 15, 14, 0, tzinfo=UTC)) is True

    def test_weekends_are_judged_in_market_local_time(self):
        # 01:00 UTC on Monday is still Sunday evening in New York.
        assert is_us_market_open(datetime(2026, 7, 20, 1, 0, tzinfo=UTC)) is False

    def test_ttl_follows_the_corrected_session(self):
        # The constants, not their current values: this test is about the session
        # boundary, and hardcoding a tuning number here made it fail the moment
        # the crypto TTL was raised - for a reason unrelated to daylight saving.
        winter_afternoon = datetime(2026, 1, 15, 20, 30, tzinfo=UTC)
        assert quote_ttl("AAPL", YFINANCE_DELAY, winter_afternoon) == YFINANCE_DELAY
        assert quote_ttl("BTC-USD", YFINANCE_DELAY, winter_afternoon) == CRYPTO_TTL_SECONDS


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
