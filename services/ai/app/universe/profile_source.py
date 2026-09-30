"""Where an on-demand profile's facts come from: one symbol's description and size.

The universe build (`scripts/build_instrument_universe.py`) fetches the same
facts for thousands of listings as an operator's tool; this is the runtime
path for one, behind an interface like every other external dependency
(guideline 6). Both map Yahoo's payload through `snapshot.to_instrument`, so an
on-demand profile and a screened one are built by the same rule and differ
only in `membership`.

A failure and "Yahoo has nothing" are different answers and are kept apart, for
the reason the build script gives: `None` is what the source said, and a
`ProfileSourceError` is that it could not be asked. Only the second is worth
retrying.
"""

from __future__ import annotations

import asyncio
from typing import Any, Protocol

from app.config import Settings
from app.core.logging import get_logger
from app.providers.price_provenance import admissible_chain
from app.universe.profiles import DESCRIPTION_LICENSE, DESCRIPTION_SOURCE
from app.universe.snapshot import UniverseInstrument, to_instrument

log = get_logger("universe.profile_source")

#: Yahoo's `quoteType`s the screen admits; anything else cannot be profiled here.
_PROFILED_QUOTE_TYPES = ("EQUITY", "ETF")


class ProfileSourceError(Exception):
    """The source could not be asked: a timeout, a refusal, a rate limit."""


class InstrumentProfileSource(Protocol):
    #: Written to the profile's `source` and `license` columns.
    source: str
    license: str

    async def profile(self, symbol: str) -> UniverseInstrument | None:
        """The listing's facts, or None when the source has no such equity or ETF.

        A returned instrument may still have no description: that is what the
        source said, and the caller records it rather than inventing one.
        Raises `ProfileSourceError` when the source could not be asked.
        """
        ...


def instrument_from_info(symbol: str, info: dict[str, Any]) -> UniverseInstrument | None:
    """Yahoo's `info` payload as a universe row, or None for anything unscreenable.

    `info` carries the screener's own fields (`quoteType`, `exchange`,
    `currency`, `marketCap`, `netAssets`), so it serves as both arguments of
    `to_instrument`. An empty payload - Yahoo's answer for a symbol it does not
    know - has no `quoteType` and is None.
    """
    if str(info.get("quoteType") or "").upper() not in _PROFILED_QUOTE_TYPES:
        return None
    if not info.get("exchange"):
        return None
    return to_instrument({**info, "symbol": symbol}, info)


class YahooProfileSource:
    source = DESCRIPTION_SOURCE
    license = DESCRIPTION_LICENSE

    def __init__(self, *, timeout_seconds: float = 20.0) -> None:
        self._timeout = timeout_seconds

    def _info_blocking(self, symbol: str) -> dict[str, Any]:
        import yfinance as yf

        try:
            return dict(yf.Ticker(symbol).get_info() or {})
        except Exception as error:  # noqa: BLE001 - yfinance raises whatever requests does
            raise ProfileSourceError(f"{type(error).__name__}: {error}") from error

    async def profile(self, symbol: str) -> UniverseInstrument | None:
        try:
            info = await asyncio.wait_for(
                asyncio.to_thread(self._info_blocking, symbol), timeout=self._timeout
            )
        except TimeoutError as error:
            raise ProfileSourceError(f"no answer within {self._timeout} s") from error
        return instrument_from_info(symbol, info)


def build_profile_source(settings: Settings) -> InstrumentProfileSource | None:
    """Yahoo when the market-data chain uses it; otherwise none.

    None is a configuration, not a failure: an installation priced by fixtures
    alone (CI, the demo) has no business fetching Yahoo's prose, and an
    on-demand request there is answered `unavailable` rather than attempted.
    """
    if "yfinance" in admissible_chain(settings.market_data_chain):
        return YahooProfileSource()
    log.info("universe.profile_source_off", chain=settings.market_data_chain)
    return None
