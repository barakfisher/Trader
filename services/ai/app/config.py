"""Typed configuration for the AI service.

Every setting is read from the environment exactly once, at import time, and
validated here. A missing or malformed required value raises at boot rather than
surfacing as a confusing runtime error later.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

#: Where the container copies the fixtures to (see infra/docker/Dockerfile.ai).
_CONTAINER_FIXTURES_DIR = "/app/data/fixtures"


def _default_fixtures_dir() -> str:
    """Locate `data/fixtures` in both places this service runs.

    In a container the code lives at /app and the fixtures are copied to
    /app/data/fixtures. Run natively from a checkout, this file is at
    <repo>/services/ai/app/config.py and the fixtures are at <repo>/data/fixtures.
    Guessing wrong is quiet and nasty: the provider loads nothing, every symbol
    falls through to the live provider, and the "works offline" promise breaks.
    """
    try:
        checkout = Path(__file__).resolve().parents[3] / "data" / "fixtures"
    except IndexError:  # pragma: no cover - only when the path is unusually short
        return _CONTAINER_FIXTURES_DIR
    return str(checkout) if checkout.is_dir() else _CONTAINER_FIXTURES_DIR


#: Placeholder shipped in .env.example. Usable in development because both
#: services read the same file; rejected outright in production.
DEFAULT_INTERNAL_API_KEY = "change-me-internal"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # Core
    app_env: Literal["development", "production", "test"] = "development"
    log_level: Literal["debug", "info", "warn", "error"] = "info"
    base_currency: str = "USD"
    app_timezone: str = "Asia/Jerusalem"
    ai_service_port: int = 8000

    # Datastores
    database_url: str = "postgresql://traders:traders@localhost:5432/traders"
    redis_url: str = "redis://localhost:6379/0"

    # Service-to-service auth for the market routes. There is no development
    # bypass (see app/deps.py); the default value below only works because both
    # services read it from the same .env and therefore agree on it.
    internal_api_key: str = DEFAULT_INTERNAL_API_KEY

    # Market data: ordered fallback chain, first provider that answers wins.
    # Kept as a raw comma-separated string because pydantic-settings decodes
    # list-typed fields as JSON when they come from a .env file; `market_data_chain`
    # is the parsed accessor every caller should use.
    market_data_providers: str = "fixture,yfinance"
    polygon_api_key: str | None = None
    alphavantage_api_key: str | None = None
    finnhub_api_key: str | None = None
    coingecko_api_key: str | None = None

    # Cache TTLs (seconds).
    # CACHE_TTL_QUOTE is the MINIMUM quote TTL, not the TTL. The effective value
    # per quote comes from app/core/cache_policy.py, which stretches it to the
    # serving provider's delay during market hours and to an hour when the market
    # is closed. This floor only matters for providers that declare no delay.
    cache_ttl_quote: int = 60
    cache_ttl_history: int = 43_200
    cache_ttl_news: int = 900

    # Per-provider outbound request budget (token bucket), requests per minute.
    provider_rate_limit_per_minute: int = 60

    # Absolute path to the fixture data directory. Resolved for the current
    # runtime; FIXTURES_DIR in the environment always wins.
    fixtures_dir: str = Field(default_factory=_default_fixtures_dir)

    # News and LLM settings arrive in later milestones; they follow the same
    # comma-separated convention as market_data_providers.

    @model_validator(mode="after")
    def _reject_default_secrets_in_production(self) -> Settings:
        """Refuse to start a production deployment with the shipped default key.

        Failing at boot is loud and costs one restart. Failing at request time,
        or not failing at all, means shipping an unprotected internal API.
        """
        if self.app_env == "production" and self.internal_api_key == DEFAULT_INTERNAL_API_KEY:
            raise ValueError(
                "INTERNAL_API_KEY is still the default value; set a real one before "
                "running with APP_ENV=production"
            )
        return self

    @property
    def market_data_chain(self) -> list[str]:
        return [
            item.strip().lower() for item in self.market_data_providers.split(",") if item.strip()
        ]

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
