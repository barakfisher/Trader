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
