"""Unit tests for the Yahoo provider's mapping layer.

The blocking fetch is stubbed: these cover how a provider response becomes a
Quote, not whether Yahoo is reachable.
"""

from datetime import UTC, datetime
from decimal import Decimal

from app.providers.yfinance_provider import YFinanceProvider


def stub_fetch(_self, symbol: str):
    return {
        "price": Decimal("333.08"),
        "previous_close": Decimal("332.23"),
        "currency": "USD",
        "quote_type": "EQUITY",
        "exchange": "NMS",
    }


async def test_quote_is_dated_to_the_delay_window(monkeypatch):
    """Yahoo's fast_info publishes no timestamp, so we must not invent precision.

    A 15-minute-delayed price stamped with the current second would misdate every
    move Milestone 2 derives from it.
    """
    monkeypatch.setattr(YFinanceProvider, "_fetch_one_blocking", stub_fetch)
    provider = YFinanceProvider()

    quotes = await provider.quotes(["AAPL"])

    assert len(quotes) == 1
    as_of = quotes[0].as_of
    assert as_of.tzinfo is not None
    assert int(as_of.timestamp()) % 900 == 0
    assert as_of <= datetime.now(UTC)


async def test_repeated_reads_share_one_observation_time(monkeypatch):
    monkeypatch.setattr(YFinanceProvider, "_fetch_one_blocking", stub_fetch)
    provider = YFinanceProvider()

    first = await provider.quotes(["AAPL"])
    second = await provider.quotes(["AAPL"])

    assert first[0].as_of == second[0].as_of


async def test_price_and_day_change_mapping(monkeypatch):
    monkeypatch.setattr(YFinanceProvider, "_fetch_one_blocking", stub_fetch)
    provider = YFinanceProvider()

    quote = (await provider.quotes(["aapl"]))[0]

    assert quote.symbol == "AAPL"
    assert quote.price_minor == 33308
    assert quote.previous_close_minor == 33223
    assert quote.day_change_pct == 0.2558
    assert quote.delay_seconds == 900
    assert quote.source == "yfinance"


async def test_resolve_carries_the_provider_name(monkeypatch):
    """The name comes from the provider or not at all.

    `fast_info` - the only thing a quote reads - publishes no display name, so
    resolution used to hardcode None and every instrument created from a live
    provider landed with a null name. The lookup is separate because `get_info()`
    is far heavier than `fast_info`, and resolution happens once per symbol.
    """
    monkeypatch.setattr(YFinanceProvider, "_fetch_one_blocking", stub_fetch)
    monkeypatch.setattr(YFinanceProvider, "_fetch_name_blocking", lambda _self, _s: "Apple Inc.")
    provider = YFinanceProvider()

    resolution = await provider.resolve("aapl")

    assert resolution.resolved is not None
    assert resolution.resolved.symbol == "AAPL"
    assert resolution.resolved.name == "Apple Inc."
    assert resolution.resolved.asset_class == "equity"


async def test_resolve_leaves_the_name_null_when_the_provider_has_none(monkeypatch):
    """An unavailable name stays null; it is never derived from the symbol."""
    monkeypatch.setattr(YFinanceProvider, "_fetch_one_blocking", stub_fetch)
    monkeypatch.setattr(YFinanceProvider, "_fetch_name_blocking", lambda _self, _s: None)
    provider = YFinanceProvider()

    resolution = await provider.resolve("AAPL")

    assert resolution.resolved is not None
    assert resolution.resolved.name is None


async def test_resolve_survives_a_failing_name_lookup(monkeypatch):
    """A priced symbol resolves even when `get_info()` throws or hangs."""

    def boom(_self, _symbol):
        raise RuntimeError("Yahoo returned HTML")

    monkeypatch.setattr(YFinanceProvider, "_fetch_one_blocking", stub_fetch)
    monkeypatch.setattr(YFinanceProvider, "_fetch_name_blocking", boom)
    provider = YFinanceProvider()

    resolution = await provider.resolve("AAPL")

    assert resolution.resolved is not None
    assert resolution.resolved.name is None
    assert resolution.confidence == 0.9
