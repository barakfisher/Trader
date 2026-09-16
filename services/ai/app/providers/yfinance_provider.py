"""Yahoo Finance provider (via the unofficial `yfinance` package).

Treated as best-effort by design: the endpoint is undocumented, unversioned and
rate-limited, and quotes are typically delayed. Good enough for development and
for a portfolio tracker; every call is wrapped so that a Yahoo outage degrades
the run instead of failing it. Swap in Polygon.io for production-grade data by
adding `polygon` to MARKET_DATA_PROVIDERS ahead of `yfinance`.

`yfinance` is synchronous and does blocking network IO, so every call is pushed
to a worker thread to keep the event loop responsive.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime, time
from decimal import Decimal, InvalidOperation

from app.core.logging import get_logger
from app.core.money import to_minor
from app.core.observation_time import observed_at
from app.models import AssetClass, DailyClose, FxRate, Instrument, InstrumentResolution, Quote
from app.providers.base import ProviderError

log = get_logger("provider.yfinance")

#: Daily closes are dated to 20:00 UTC, matching the fixture provider so the two
#: interleave in one series without reordering.
CLOSE_TIME = time(20, 0, tzinfo=UTC)

# Yahoo's quoteType vocabulary mapped onto ours.
_QUOTE_TYPE_MAP: dict[str, AssetClass] = {
    "EQUITY": "equity",
    "ETF": "etf",
    "MUTUALFUND": "etf",
    "CRYPTOCURRENCY": "crypto",
    "CURRENCY": "fx",
    "INDEX": "index",
}


def _as_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        decimal_value = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return decimal_value if decimal_value > 0 else None


class YFinanceProvider:
    name = "yfinance"
    delay_seconds = 900  # Yahoo serves most exchanges on a 15-minute delay.
    # `fast_info` publishes no timestamp at all (no regularMarketTime, no
    # lastTradeTime), so an observation can only be dated to the delay window it
    # came from. Claiming more precision than that would be a fabrication.
    quote_granularity_seconds = 900
    makes_external_requests = True
    # `quotes()` fans out one `Ticker` read per symbol (see the gather below), so
    # a 10-symbol request costs 10 upstream requests, not 1.
    batches_requests = False

    def __init__(self, *, timeout_seconds: float = 12.0) -> None:
        self._timeout = timeout_seconds

    # -- internals ------------------------------------------------------------

    def _fetch_one_blocking(self, symbol: str) -> dict | None:
        """Read one symbol's last price. Runs in a worker thread."""
        import yfinance as yf

        ticker = yf.Ticker(symbol)

        price: Decimal | None = None
        previous: Decimal | None = None
        currency: str | None = None
        quote_type: str | None = None
        exchange: str | None = None

        # fast_info is a single lightweight request; prefer it.
        try:
            fast = ticker.fast_info
            price = _as_decimal(fast.get("lastPrice"))
            previous = _as_decimal(fast.get("previousClose"))
            currency = fast.get("currency")
            quote_type = fast.get("quoteType")
            exchange = fast.get("exchange")
        except Exception as exc:  # noqa: BLE001 - third-party surface is unpredictable
            log.debug("yfinance.fast_info_failed", symbol=symbol, error=str(exc))

        # Fall back to two daily candles when fast_info gives nothing usable.
        if price is None:
            try:
                frame = ticker.history(period="5d", interval="1d", auto_adjust=False)
                closes = (
                    [c for c in frame["Close"].tolist() if c and c > 0] if not frame.empty else []
                )
                if closes:
                    price = _as_decimal(closes[-1])
                    if len(closes) > 1:
                        previous = _as_decimal(closes[-2])
            except Exception as exc:  # noqa: BLE001
                log.debug("yfinance.history_failed", symbol=symbol, error=str(exc))

        if price is None:
            return None

        return {
            "price": price,
            "previous_close": previous,
            "currency": (currency or "USD").upper(),
            "quote_type": quote_type,
            "exchange": exchange,
        }

    # -- provider contract ----------------------------------------------------

    async def quotes(self, symbols: list[str]) -> list[Quote]:
        as_of = observed_at(datetime.now(UTC), self.quote_granularity_seconds)

        async def one(symbol: str) -> Quote | None:
            try:
                raw = await asyncio.wait_for(
                    asyncio.to_thread(self._fetch_one_blocking, symbol),
                    timeout=self._timeout,
                )
            except TimeoutError:
                log.warning("yfinance.timeout", symbol=symbol)
                return None
            except Exception as exc:  # noqa: BLE001
                raise ProviderError(self.name, str(exc)) from exc
            if raw is None:
                return None

            currency = raw["currency"]
            price_minor = to_minor(raw["price"], currency)
            previous_minor = (
                to_minor(raw["previous_close"], currency) if raw["previous_close"] else None
            )
            day_change_pct = (
                round((price_minor - previous_minor) / previous_minor * 100, 4)
                if previous_minor
                else None
            )
            return Quote(
                symbol=symbol.upper(),
                price_minor=price_minor,
                currency=currency,
                as_of=as_of,
                source=self.name,
                delay_seconds=self.delay_seconds,
                previous_close_minor=previous_minor,
                day_change_pct=day_change_pct,
            )

        # Yahoo tolerates modest concurrency; keep it low to stay under the radar.
        semaphore = asyncio.Semaphore(8)

        async def guarded(symbol: str) -> Quote | None:
            async with semaphore:
                return await one(symbol)

        settled = await asyncio.gather(*(guarded(s) for s in symbols), return_exceptions=True)
        quotes: list[Quote] = []
        errors = 0
        for item in settled:
            if isinstance(item, Quote):
                quotes.append(item)
            elif isinstance(item, BaseException):
                errors += 1
        if errors and not quotes:
            raise ProviderError(self.name, f"all {errors} symbol requests failed")
        return quotes

    def _history_blocking(self, symbol: str, days: int) -> list[tuple[date, Decimal, str]]:
        """Daily candles for one symbol. Runs in a worker thread."""
        import yfinance as yf

        ticker = yf.Ticker(symbol)
        # auto_adjust=False keeps the close as it was printed. An adjusted series
        # rewrites history after every dividend and split, so yesterday's
        # "closing price" would change under us - and an observation citing a
        # price the user can no longer find is worse than no observation.
        frame = ticker.history(period=f"{max(days, 1)}d", interval="1d", auto_adjust=False)
        if frame.empty:
            return []

        currency = "USD"
        try:
            currency = (ticker.fast_info.get("currency") or "USD").upper()
        except Exception as exc:  # noqa: BLE001 - third-party surface
            log.debug("yfinance.history_currency_failed", symbol=symbol, error=str(exc))

        closes: list[tuple[date, Decimal, str]] = []
        for timestamp, row in frame.iterrows():
            price = _as_decimal(row.get("Close"))
            if price is None:
                continue
            closes.append((timestamp.date(), price, currency))
        return closes

    async def history(self, symbol: str, days: int) -> list[DailyClose]:
        try:
            raw = await asyncio.wait_for(
                asyncio.to_thread(self._history_blocking, symbol, days),
                timeout=self._timeout * 3,  # a year of candles is a bigger read
            )
        except TimeoutError:
            log.warning("yfinance.history_timeout", symbol=symbol)
            return []
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(self.name, str(exc)) from exc

        return [
            DailyClose(
                symbol=symbol.upper(),
                as_of=datetime.combine(day, CLOSE_TIME),
                price_minor=to_minor(price, currency),
                currency=currency,
                source=self.name,
            )
            for day, price, currency in raw
        ]

    async def resolve(self, query: str) -> InstrumentResolution:
        candidate = query.strip().upper()
        raw = None
        try:
            raw = await asyncio.wait_for(
                asyncio.to_thread(self._fetch_one_blocking, candidate),
                timeout=self._timeout,
            )
        except (TimeoutError, Exception) as exc:  # noqa: BLE001
            log.debug("yfinance.resolve_failed", query=query, error=str(exc))

        if raw is None:
            return InstrumentResolution(
                query=query,
                confidence=0.0,
                reason="Yahoo Finance returned no price for this symbol",
            )

        asset_class = _QUOTE_TYPE_MAP.get((raw.get("quote_type") or "").upper(), "unknown")
        return InstrumentResolution(
            query=query,
            resolved=Instrument(
                symbol=candidate,
                name=None,
                asset_class=asset_class,
                exchange=raw.get("exchange"),
                currency=raw["currency"],
                source=self.name,
            ),
            confidence=0.9,
            reason="symbol priced successfully by Yahoo Finance",
        )

    async def fx_rate(self, base: str, quote: str) -> FxRate | None:
        base, quote = base.upper(), quote.upper()
        if base == quote:
            return FxRate(
                base=base,
                quote=quote,
                rate="1",
                as_of=observed_at(datetime.now(UTC), self.quote_granularity_seconds),
                source=self.name,
            )
        # Yahoo expresses FX pairs as e.g. "ILSUSD=X".
        raw = await asyncio.to_thread(self._fetch_one_blocking, f"{base}{quote}=X")
        if raw is None:
            return None
        return FxRate(
            base=base,
            quote=quote,
            rate=str(raw["price"]),
            as_of=observed_at(datetime.now(UTC), self.quote_granularity_seconds),
            source=self.name,
        )
