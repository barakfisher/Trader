"""Market data provider contract.

Everything that talks to the outside world for prices sits behind this Protocol.
Swapping yfinance for Polygon.io means adding one class and one line of config -
no call site changes. See DESIGN.md section 4.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.models import FxRate, InstrumentResolution, Quote


class ProviderError(RuntimeError):
    """Raised for any provider-side failure. The chain catches it and moves on."""

    def __init__(self, provider: str, message: str) -> None:
        super().__init__(f"{provider}: {message}")
        self.provider = provider


@runtime_checkable
class MarketDataProvider(Protocol):
    #: Stable identifier, recorded on every Quote as `source`.
    name: str

    #: Provider-declared quote delay in seconds (0 = real time).
    delay_seconds: int

    #: How far apart two genuinely different observations can be. Used to floor
    #: `Quote.as_of` when the provider publishes no timestamp of its own, so a
    #: repeated read of the same underlying data yields the same `as_of`.
    #: See app/core/observation_time.py.
    quote_granularity_seconds: int

    #: Does calling this provider consume an external quota? False for
    #: FixtureProvider, which reads a local JSON file and has no upstream to
    #: protect. The chain skips rate limiting entirely for such providers, so a
    #: burst of offline requests cannot lock the demo out of its own fixtures.
    makes_external_requests: bool

    #: Does `quotes()` price the whole list in one upstream request? False for
    #: yfinance, which issues one HTTP request per symbol; True for providers
    #: with a genuine multi-symbol endpoint (Polygon's grouped snapshot). This is
    #: what the limiter charges against: a 10-symbol call costs 10 requests from
    #: a non-batching provider and 1 from a batching one, and charging 1 for both
    #: made the limiter under-report usage by the batch size.
    batches_requests: bool

    async def quotes(self, symbols: list[str]) -> list[Quote]:
        """Price as many of `symbols` as possible. Unknown symbols are omitted,
        never faked. Raising ProviderError means "provider is unusable right now"."""
        ...

    async def resolve(self, query: str) -> InstrumentResolution:
        """Map a user-supplied string to an instrument, or return candidates."""
        ...

    async def fx_rate(self, base: str, quote: str) -> FxRate | None:
        """Spot rate for base->quote, or None when the provider cannot serve it."""
        ...
