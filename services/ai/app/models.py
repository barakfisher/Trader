"""Wire models shared with the orchestrator.

These pydantic models are the source of truth for the OpenAPI schema, which is
what `packages/shared` generates its TypeScript client from. Keep field names
stable: renaming one is a breaking API change.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

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


class DailyClose(BaseModel):
    """One day's closing price.

    `as_of` is dated to the session close rather than to midnight, so a daily
    close and an intraday quote for the same instrument order sensibly in one
    series. Money is integer minor units, as everywhere.
    """

    symbol: str
    as_of: datetime
    price_minor: int
    currency: str
    source: str


class BackfillInstrument(BaseModel):
    instrument_id: str
    symbol: str


class BackfillRequest(BaseModel):
    """Which instruments to fetch daily closes for, and how far back."""

    instruments: list[BackfillInstrument] = Field(min_length=1, max_length=500)
    days: int = Field(default=180, ge=2, le=3650)


class BackfillResponse(BaseModel):
    written: int = 0
    already_present: int = 0
    per_symbol: dict[str, int] = Field(default_factory=dict)
    without_history: list[str] = Field(
        default_factory=list,
        description=(
            "Symbols no provider could supply a series for. Reported rather than "
            "omitted: a holding the engine cannot analyse is something the user "
            "should be able to discover."
        ),
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


# --- Analysis (Milestone 2) ---------------------------------------------------

Severity = Literal["info", "notable", "high"]
NarrationSource = Literal["llm", "template"]


class ScanHolding(BaseModel):
    """One holding as the scan needs it.

    `value_minor` is the holding's market value in the portfolio's base currency,
    computed by the orchestrator, which owns valuation and the FX rates. It is
    null when the holding could not be priced - carried rather than omitted so
    the scan can report that allocation drift was skipped, and why.
    """

    instrument_id: str
    symbol: str
    value_minor: int | None = None
    currency: str = "USD"
    as_of: datetime | None = Field(
        default=None,
        description=(
            "When the price behind value_minor was observed. Allocation drift dates a "
            "weight by the stalest price contributing to it, so a position without this "
            "cannot take part."
        ),
    )


class PortfolioScanRequest(BaseModel):
    base_currency: str = "USD"
    holdings: list[ScanHolding] = Field(min_length=1, max_length=500)
    target_weights: dict[str, str] = Field(
        default_factory=dict,
        description="symbol -> target weight as a decimal string, e.g. {'VOO': '0.25'}.",
    )
    known_dedupe_keys: list[str] = Field(
        default_factory=list,
        max_length=5000,
        description=(
            "Dedupe keys the caller has already stored. Matching findings are counted "
            "and skipped before narration, so a repeat costs a hash rather than a model "
            "call. Omit to narrate everything."
        ),
    )


class ObservationOut(BaseModel):
    """A finding, its words, and its identity.

    `evidence` carries every figure the headline and explanation rest on; the
    narration validator rejects any that is not here. `narration_source` says who
    wrote the words, and `fallback_reason` why the model did not, so the
    rejection rate is measurable.
    """

    kind: str
    severity: Severity
    subject_ref: str
    as_of: datetime
    headline: str
    explanation: str
    evidence: dict[str, Any] = Field(default_factory=dict)
    concept_refs: list[str] = Field(default_factory=list)
    dedupe_key: str
    narration_source: NarrationSource
    fallback_reason: str = "none"


class ScanStatsOut(BaseModel):
    subjects: int = 0
    subjects_with_history: int = 0
    findings: int = 0
    already_known: int = 0
    narrated_by_llm: int = 0
    narration_fallbacks: dict[str, int] = Field(default_factory=dict)
    drift_skipped_reason: str | None = None
    insufficient_history: list[str] = Field(default_factory=list)


class PortfolioScanResponse(BaseModel):
    observations: list[ObservationOut]
    stats: ScanStatsOut


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    service: str = "ai-service"
    version: str
    checks: dict[str, str] = Field(default_factory=dict)
