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
