"""Typed configuration for the AI service.

Every setting is read from the environment exactly once, at import time, and
validated here. A missing or malformed required value raises at boot rather than
surfacing as a confusing runtime error later.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


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

    # Service-to-service auth for /internal routes.
    internal_api_key: str = "change-me-internal"

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
    cache_ttl_quote: int = 60
    cache_ttl_history: int = 43_200
    cache_ttl_news: int = 900

    # Per-provider outbound request budget (token bucket), requests per minute.
    provider_rate_limit_per_minute: int = 60

    # Absolute path to the fixture data directory (mounted into the container).
    fixtures_dir: str = "/app/data/fixtures"

    # News and LLM settings arrive in later milestones; they follow the same
    # comma-separated convention as market_data_providers.

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
