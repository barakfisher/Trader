from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.config import Settings
from app.core.cache import Cache
from app.core.ratelimit import RateLimiter
from app.news.entities import EntityMatcher, InstrumentRef
from app.news.fixture import FixtureNewsProvider
from app.providers.fixture import FixtureProvider
from app.providers.registry import MarketDataService
from tests.fakes import FakeRedis

FIXTURES_DIR = Path(__file__).resolve().parents[3] / "data" / "fixtures"

#: Tests must not depend on the developer's .env. Every test that exercises an
#: authenticated route uses this key and overrides the settings dependency, so
#: the suite behaves identically on a laptop with a .env and on a bare CI runner.
TEST_INTERNAL_KEY = "test-internal-key"


@pytest.fixture
def settings() -> Settings:
    return Settings(
        # `_env_file=None` keeps the suite off the developer's .env: a test whose
        # result depends on a file outside the repository passes on one machine
        # and fails on another, and the green one is the misleading result.
        _env_file=None,
        app_env="test",
        market_data_providers="fixture",
        fixtures_dir=str(FIXTURES_DIR),
        cache_ttl_quote=60,
        internal_api_key=TEST_INTERNAL_KEY,
    )


@pytest.fixture
def fixture_provider(settings: Settings) -> FixtureProvider:
    return FixtureProvider(settings.fixtures_dir)


@pytest.fixture
def market_data(settings: Settings, fixture_provider: FixtureProvider) -> MarketDataService:
    redis = FakeRedis()
    return MarketDataService([fixture_provider], Cache(redis), RateLimiter(redis), settings)


@pytest.fixture
def news_instruments() -> list[InstrumentRef]:
    """The demo portfolio's instrument universe, read from the fixture the app reads.

    A literal list here would drift from `instruments.json`, and being right about
    that file is the entity matcher's entire job.
    """
    items = json.loads((FIXTURES_DIR / "instruments.json").read_text())
    return [
        InstrumentRef(
            symbol=item["symbol"],
            name=item.get("name"),
            asset_class=item.get("asset_class", "unknown"),
            # A stand-in for the database id, so the tests exercise the same
            # carrying-through of instrument_id that the real pipeline does.
            instrument_id=f"instrument-{item['symbol']}",
        )
        for item in items
    ]


@pytest.fixture
def matcher(news_instruments: list[InstrumentRef]) -> EntityMatcher:
    return EntityMatcher(news_instruments)


@pytest.fixture
def news_provider(settings: Settings) -> FixtureNewsProvider:
    return FixtureNewsProvider(settings.fixtures_dir)
