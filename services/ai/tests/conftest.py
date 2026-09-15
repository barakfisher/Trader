from __future__ import annotations

from pathlib import Path

import pytest

from app.config import Settings
from app.core.cache import Cache
from app.core.ratelimit import RateLimiter
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
