"""A fixture price is the demo's, and never stands in for a real one (guideline 7)."""

from __future__ import annotations

from app.config import Settings
from app.providers.price_provenance import (
    FIXTURE,
    admissible_chain,
    excluded_price_sources,
    is_demo_chain,
)
from app.providers.registry import build_providers


def test_a_demo_chain_keeps_its_fixture_prices_and_its_real_fallback():
    # .env.example's chain: a fresh clone and CI run offline on fixtures.
    assert is_demo_chain(["fixture", "yfinance"])
    assert admissible_chain(["fixture", "yfinance"]) == ["fixture", "yfinance"]
    assert excluded_price_sources(["fixture", "yfinance"]) == ()


def test_a_real_chain_never_falls_back_to_invented_prices():
    # This machine's .env had yfinance,fixture: a Yahoo failure became a fixture
    # price, and a fixture $118.45 beside real ~$218 closes became a -48.6% drawdown.
    assert not is_demo_chain(["yfinance", "fixture"])
    assert admissible_chain(["yfinance", "fixture"]) == ["yfinance"]
    assert excluded_price_sources(["yfinance", "fixture"]) == (FIXTURE,)


def test_a_real_chain_without_fixture_still_skips_stored_fixture_rows():
    assert excluded_price_sources(["yfinance"]) == (FIXTURE,)


def test_the_registry_builds_only_the_admissible_chain():
    settings = Settings(_env_file=None, market_data_providers="yfinance,fixture")
    assert [provider.name for provider in build_providers(settings)] == ["yfinance"]

    demo = Settings(_env_file=None, market_data_providers="fixture,yfinance")
    assert [provider.name for provider in build_providers(demo)] == ["fixture", "yfinance"]
