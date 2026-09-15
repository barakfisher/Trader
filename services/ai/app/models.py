"""Wire models shared with the orchestrator.

These pydantic models are the source of truth for the OpenAPI schema, which is
what `packages/shared` generates its TypeScript client from. Keep field names
stable: renaming one is a breaking API change.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

AssetClass = Literal["equity", "etf", "crypto", "fx", "index", "unknown"]


class Quote(BaseModel):
    """A single price observation. `price_minor` is integer minor units."""

    symbol: str
    price_minor: int
    currency: str
    as_of: datetime = Field(
        description=(
            "When this price was observed, not when it was fetched. Providers that "
            "publish a trade timestamp supply it directly; for the rest it is the "
            "fetch time floored to the provider's freshness window, so repeated "
            "reads of one observation share an as_of and deduplicate on storage."
        )
    )
    source: str = Field(
        description="Provider that produced this quote, e.g. 'fixture', 'yfinance'."
    )
    delay_seconds: int = Field(
        default=0,
        description="Provider-declared quote delay. Displayed in the UI; 0 means real time.",
    )
    previous_close_minor: int | None = None
    day_change_pct: float | None = None
    stale: bool = Field(
        default=False,
        description="True when served from cache after every live provider failed.",
    )


class QuoteRequest(BaseModel):
    symbols: list[str] = Field(min_length=1, max_length=200)


class QuoteResponse(BaseModel):
    quotes: list[Quote]
    missing: list[str] = Field(
        default_factory=list,
        description="Symbols no provider in the chain could price.",
    )


class Instrument(BaseModel):
    symbol: str = Field(description="Canonical provider symbol, e.g. 'AAPL', 'BTC-USD'.")
    name: str | None = None
    asset_class: AssetClass = "unknown"
    exchange: str | None = None
    currency: str = "USD"
    source: str = "unknown"


class InstrumentResolution(BaseModel):
    """Result of resolving a user-supplied string to a tradable instrument.

    `candidates` is non-empty and ordered by confidence whenever `resolved` is
    None, so the UI can ask the user to disambiguate instead of guessing.
    """

    query: str
    resolved: Instrument | None = None
    candidates: list[Instrument] = Field(default_factory=list)
    confidence: float = 0.0
    reason: str | None = None


class FxRate(BaseModel):
    base: str
    quote: str
    rate: str = Field(description="Decimal as string to avoid float drift in transport.")
    as_of: datetime
    source: str


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    service: str = "ai-service"
    version: str
    checks: dict[str, str] = Field(default_factory=dict)
