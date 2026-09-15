import pytest

from app.providers.fixture import FixtureProvider


async def test_quotes_return_minor_units_and_day_change(fixture_provider: FixtureProvider):
    quotes = await fixture_provider.quotes(["aapl"])
    assert len(quotes) == 1
    quote = quotes[0]
    assert quote.symbol == "AAPL"
    assert quote.price_minor == 23214
    assert quote.currency == "USD"
    assert quote.previous_close_minor == 22979
    assert quote.day_change_pct == pytest.approx(1.0227, abs=1e-3)


async def test_unknown_symbols_are_omitted_not_invented(fixture_provider: FixtureProvider):
    quotes = await fixture_provider.quotes(["AAPL", "NOPE"])
    assert [q.symbol for q in quotes] == ["AAPL"]


async def test_resolve_exact_symbol(fixture_provider: FixtureProvider):
    result = await fixture_provider.resolve("btc-usd")
    assert result.resolved is not None
    assert result.resolved.asset_class == "crypto"
    assert result.confidence == 1.0


async def test_resolve_by_name_returns_candidates_without_guessing(
    fixture_provider: FixtureProvider,
):
    result = await fixture_provider.resolve("Vanguard")
    assert result.resolved is None
    assert [c.symbol for c in result.candidates] == ["VOO"]


async def test_fx_rate_and_identity(fixture_provider: FixtureProvider):
    assert (await fixture_provider.fx_rate("USD", "USD")).rate == "1"
    eur = await fixture_provider.fx_rate("EUR", "USD")
    assert eur is not None and eur.rate == "1.1043"
    assert await fixture_provider.fx_rate("USD", "XYZ") is None


async def test_repeated_reads_share_one_observation_time(fixture_provider: FixtureProvider):
    """The property `quotes (instrument_id, as_of)` relies on to deduplicate.

    Two reads seconds apart describe the same underlying price, so they must
    carry the same as_of - otherwise every dashboard refresh appends a duplicate
    row to the price history.
    """
    first = await fixture_provider.quotes(["AAPL"])
    second = await fixture_provider.quotes(["AAPL"])
    assert first[0].as_of == second[0].as_of


async def test_observation_time_is_floored_to_the_provider_window(
    fixture_provider: FixtureProvider,
):
    quotes = await fixture_provider.quotes(["AAPL"])
    as_of = quotes[0].as_of
    assert int(as_of.timestamp()) % fixture_provider.quote_granularity_seconds == 0
    assert as_of.microsecond == 0


async def test_observation_time_is_never_in_the_future(fixture_provider: FixtureProvider):
    from datetime import UTC, datetime

    quotes = await fixture_provider.quotes(["AAPL"])
    assert quotes[0].as_of <= datetime.now(UTC)
