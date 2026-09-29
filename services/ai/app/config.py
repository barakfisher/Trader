"""Typed configuration for the AI service.

Every setting is read from the environment exactly once, at import time, and
validated here. A missing or malformed required value raises at boot rather than
surfacing as a confusing runtime error later.
"""

from __future__ import annotations

from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.llm.pricing import ModelPrice, parse_model_prices

#: Where the container copies the fixtures to (see infra/docker/Dockerfile.ai).
_CONTAINER_FIXTURES_DIR = "/app/data/fixtures"

#: Where the container copies the concept corpus to (same Dockerfile).
_CONTAINER_CORPUS_DIR = "/app/data/corpus"
_CONTAINER_OUTLETS_DIR = "/app/data/outlets"


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


def _default_corpus_dir() -> str:
    """Locate `data/corpus`, in both places this service runs.

    Same problem and same answer as the fixtures above. Guessing wrong here is
    quieter still: the ingester reports "no documents found" and exits, and the
    concept chips then point at an empty corpus - which looks exactly like the
    dead labels M3 exists to remove.
    """
    try:
        checkout = Path(__file__).resolve().parents[3] / "data" / "corpus"
    except IndexError:  # pragma: no cover - only when the path is unusually short
        return _CONTAINER_CORPUS_DIR
    return str(checkout) if checkout.is_dir() else _CONTAINER_CORPUS_DIR


def _default_outlets_dir() -> str:
    """Locate `data/outlets`, in both places this service runs, as the corpus is.

    Guessing wrong is loud: discovery refuses to start without its table rather
    than calling every outlet countryless and every local story a theme.
    """
    try:
        checkout = Path(__file__).resolve().parents[3] / "data" / "outlets"
    except IndexError:  # pragma: no cover - only when the path is unusually short
        return _CONTAINER_OUTLETS_DIR
    return str(checkout) if checkout.is_dir() else _CONTAINER_OUTLETS_DIR


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

    # Per-provider outbound request budget, requests per minute.
    provider_rate_limit_per_minute: int = 60

    # Per-provider daily caps, "alphavantage=25,finnhub=60". Free tiers are
    # capped per day as well as per minute, and a per-minute limiter cannot
    # protect a daily cap. Raw string for the same reason as
    # market_data_providers (pydantic-settings decodes dict-typed fields from a
    # .env file as JSON); `provider_daily_limit_map` is the parsed accessor.
    # Empty means no daily cap for any provider.
    provider_daily_limits: str = ""

    # Analysis rule layer (app/analysis). Fractions, never percentages: 0.03 is
    # 3%. Each rule has three ascending bands - the emit floor, then notable,
    # then high - and a finding's severity is whichever band its statistic
    # clears; see app/analysis/findings.py. The defaults live in
    # AnalysisThresholds and are mirrored here so an operator can retune without
    # touching code.
    analysis_price_move_pct: float = 0.03
    analysis_price_move_notable_pct: float = 0.05
    analysis_price_move_high_pct: float = 0.08

    # Sigma move: today's return over the trailing standard deviation of returns.
    # ANALYSIS_SIGMA_MIN_MOVE_PCT keeps a quiet instrument's 0.3% wiggle from
    # reading as a 4-sigma event, and ANALYSIS_SIGMA_STDEV_FLOOR keeps a
    # near-flat series from becoming a small denominator.
    analysis_sigma_z: float = 2.0
    analysis_sigma_notable_z: float = 3.0
    analysis_sigma_high_z: float = 4.0
    analysis_sigma_window_days: int = 30
    analysis_sigma_min_observations: int = 10
    analysis_sigma_min_move_pct: float = 0.01
    analysis_sigma_stdev_floor: float = 0.0025

    # Drawdown from the trailing high inside a window ("local high", FR-6).
    analysis_drawdown_pct: float = 0.10
    analysis_drawdown_notable_pct: float = 0.15
    analysis_drawdown_high_pct: float = 0.25
    analysis_drawdown_window_days: int = 30
    analysis_drawdown_min_observations: int = 5

    # Allocation drift, in weight difference: 0.05 is five percentage points of
    # portfolio weight away from the target, not 5% of the target.
    analysis_drift_pct: float = 0.05
    analysis_drift_notable_pct: float = 0.10
    analysis_drift_high_pct: float = 0.15

    # Widest calendar gap, in days, that two consecutive observations may span and
    # still be described as a one-day move. Four covers a Friday-to-Tuesday
    # holiday weekend; five covers the awkward ones.
    analysis_max_gap_days: float = 5.0

    # Absolute path to the fixture data directory. Resolved for the current
    # runtime; FIXTURES_DIR in the environment always wins.
    fixtures_dir: str = Field(default_factory=_default_fixtures_dir)

    # Absolute path to the concept corpus. Resolved for the current runtime;
    # CORPUS_DIR in the environment always wins.
    corpus_dir: str = Field(default_factory=_default_corpus_dir)

    # Absolute path to the outlet-country table (`data/outlets`, decision 61).
    # Resolved for the current runtime; OUTLETS_DIR in the environment always wins.
    outlets_dir: str = Field(default_factory=_default_outlets_dir)

    # Which embedder turns corpus text into vectors. One gateway module
    # (app/corpus/embedder_factory.py) reads this; no call site names a
    # provider. `fixture` is deterministic, keyless and offline, which is what
    # CI and a fresh clone need - and unlike the LLM chain, an unusable value
    # here raises rather than degrading, because retrieval that silently ranks
    # by nothing is indistinguishable from retrieval that works.
    embeddings_provider: str = "fixture"

    # Which model the paid embedder asks for. Only consulted when
    # EMBEDDINGS_PROVIDER names a real provider; the fixture has no model to
    # choose. The default is the model `kb_chunks.embedding` was sized for -
    # see migration 0013, which records why 1536 and not another width.
    #
    # Switching this to `openai/text-embedding-3-large` needs one more line in
    # app/corpus/openrouter_embedder.py (`"dimensions": 1536`), because it is
    # natively 3072 wide. Without that line it fails on its first call with both
    # numbers named rather than storing anything, which is the safe direction.
    embeddings_model: str = "openai/text-embedding-3-small"

    # Embedding a batch of 64 chunks is one request and is not on a user's
    # critical path during ingestion; a query embedding is, but it is ten tokens
    # and returns in well under a second. Thirty seconds is the same ceiling the
    # LLM adapter uses and exists to stop a wedged request holding a run open.
    embeddings_timeout_seconds: float = 30.0

    # News providers: ordered chain, same comma-separated convention as
    # market_data_providers and for the same pydantic-settings reason. Unlike the
    # quote chain this one is not a fallback - `app/news/ingestion.py` queries
    # every provider in it, because two news sources carry different outlets
    # while two quote sources carry the same price. `news_chain` is the parsed
    # accessor every caller should use.
    news_providers: str = "fixture"
    newsapi_key: str | None = None

    # LLM access. One gateway module (app/llm) reads all of this; no call site
    # names a provider. An unusable value here degrades to no narration rather
    # than failing at boot - see app/llm/factory.py for why this differs from
    # the internal-key check below.
    llm_provider: str = "openrouter"
    # A `:free` OpenRouter route by default, so a fresh clone with a key can
    # narrate without a spending decision. Free routes are a shared pool and
    # answer 429 under load; the adapter retries once and the pipeline falls
    # back to a template, which is the same degradation as any other provider
    # failure. Point this at a paid model when narration quality matters more
    # than it costs.
    llm_model: str = "nvidia/nemotron-3-super-120b-a12b:free"
    llm_temperature: float = 0.1

    # How much thinking a reasoning model may do before it answers. Empty means
    # "send nothing and let the model decide", which is right for a model that
    # does not reason. It matters because reasoning is billed out of
    # llm_max_output_tokens - see app/llm/openai_compatible.py.
    llm_reasoning_effort: str = "low"

    # Hard ceiling on estimated LLM spend per UTC day, enforced in
    # app/llm/budget.py. Decimal, never float, per guideline 3. Zero means no
    # paid calls at all: unlike the per-provider request limits above, 0 does
    # NOT mean unlimited here, because an unset spend ceiling reading as
    # "unlimited" is the worst way for this setting to fail.
    llm_daily_budget_usd: Decimal = Decimal("5")

    # Per-call limits. A narration is a headline plus a short explanation, so the
    # output cap is small on purpose: it bounds both the latency of a scheduled
    # run and the cost of a model that decides to be expansive.
    llm_max_output_tokens: int = 700
    llm_timeout_seconds: float = 30.0

    # Token prices, "model=input_per_mtok/output_per_mtok" in USD per million
    # tokens, layered over the documented defaults in app/llm/pricing.py. Raw
    # string for the same reason as provider_daily_limits (pydantic-settings
    # decodes dict-typed fields from a .env file as JSON); the parsed accessor is
    # `llm_model_price_map`. Prices drift, so this is configuration rather than a
    # constant: repricing a model must not need a release.
    llm_model_prices: str = ""

    # Charged for a model with no configured price. Not zero: an unpriced model
    # treated as free would run all day against a budget that never moves. See
    # app/llm/pricing.py for the full reasoning.
    llm_unknown_model_price_usd_per_mtok: Decimal = Decimal("20")

    openrouter_api_key: str | None = None
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    # Ollama's root URL; the adapter appends the /v1 compatibility prefix.
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2"

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

    @model_validator(mode="after")
    def _validate_daily_limits(self) -> Settings:
        """Surface a malformed PROVIDER_DAILY_LIMITS at boot, not mid-request."""
        _ = self.provider_daily_limit_map
        return self

    @model_validator(mode="after")
    def _validate_llm_prices(self) -> Settings:
        """Surface a malformed LLM_MODEL_PRICES at boot, not on the first call."""
        _ = self.llm_model_price_map
        return self

    @property
    def llm_model_price_map(self) -> dict[str, ModelPrice]:
        """Parse LLM_MODEL_PRICES over app/llm/pricing.py's documented defaults."""
        return parse_model_prices(self.llm_model_prices)

    @property
    def market_data_chain(self) -> list[str]:
        return [
            item.strip().lower() for item in self.market_data_providers.split(",") if item.strip()
        ]

    @property
    def news_chain(self) -> list[str]:
        return [item.strip().lower() for item in self.news_providers.split(",") if item.strip()]

    @property
    def provider_daily_limit_map(self) -> dict[str, int]:
        """Parse PROVIDER_DAILY_LIMITS into {provider: requests_per_day}.

        A malformed entry raises, and `_validate_daily_limits` calls this at boot
        so it raises there rather than on the first quote request. A typo in a
        budget would otherwise read as "no cap on that provider", which is
        exactly the failure this setting exists to prevent.
        """
        limits: dict[str, int] = {}
        for item in self.provider_daily_limits.split(","):
            entry = item.strip()
            if not entry:
                continue
            name, separator, raw_limit = entry.partition("=")
            if not separator or not name.strip():
                raise ValueError(
                    f"PROVIDER_DAILY_LIMITS entry {entry!r} is not in the form provider=limit"
                )
            try:
                limits[name.strip().lower()] = int(raw_limit.strip())
            except ValueError as exc:
                raise ValueError(
                    f"PROVIDER_DAILY_LIMITS entry {entry!r} has a non-integer limit"
                ) from exc
        return limits

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
