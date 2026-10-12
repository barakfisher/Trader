"""The eval's market: the committed fixture prices, plus the few symbols the cases need.

The eval set's `demo` account holds AMD and CCJ and asks about Tesla and oil,
which `data/fixtures/quotes.json` does not price. Adding them there would move
every test that reads the fixture, so they live here instead, priced the same
way: a fixed quote, and a deterministic daily series that ends yesterday at the
quote's previous close. Invented, like the fixture's own numbers - nothing is
to be read into them.

Two symbols stay unpriced on purpose: `UNPRICED_SYMBOL`, the `unpriced`
fixture's holding, and anything the cases name only to be told it is unknown.

Quotes are labelled delayed by `DELAY_SECONDS`, as the deployed chain's are
(Yahoo's are 15 minutes behind); the fixture's own say 0, which no real quote does.

Answers the two calls the tools make (`quotes`, `history`), as the tools'
integration tests' `ScriptedMarket` does; `ToolContext.market` is duck-typed.
"""

from __future__ import annotations

import random
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from app.core.money import to_minor
from app.models import DailyClose, Quote
from app.providers.fixture import CLOSE_TIME, FixtureProvider

#: Symbol -> (price, previous close). USD.
EXTRA_QUOTES: dict[str, tuple[str, str]] = {
    "AMD": ("162.40", "160.15"),
    "CCJ": ("61.20", "60.55"),
    "TSLA": ("251.80", "258.05"),
    "XOM": ("118.30", "115.90"),
    "USO": ("79.10", "77.25"),
}
#: The `unpriced` fixture's extra holding: in the universe, priced by nobody.
UNPRICED_SYMBOL = "LEU"
#: How far behind every quote is said to be: the deployed provider's delay.
DELAY_SECONDS = 900
#: Trading days of history behind each extra quote.
EXTRA_HISTORY_DAYS = 130


def _weekdays_back(end: date, count: int) -> list[date]:
    days: list[date] = []
    day = end
    while len(days) < count:
        if day.weekday() < 5:
            days.append(day)
        day -= timedelta(days=1)
    return days[::-1]


def extra_series(symbol: str, last_close: Decimal, end: date) -> list[tuple[date, Decimal]]:
    """A random walk seeded by the symbol, scaled so its last close is `last_close`."""
    rng = random.Random(symbol)
    level = Decimal(1)
    levels = [level]
    for _ in range(EXTRA_HISTORY_DAYS - 1):
        level *= Decimal(1) + Decimal(str(round(rng.gauss(0.0004, 0.018), 5)))
        levels.append(level)
    scale = last_close / levels[-1]
    days = _weekdays_back(end, EXTRA_HISTORY_DAYS)
    return [
        (day, (lvl * scale).quantize(Decimal("0.01")))
        for day, lvl in zip(days, levels, strict=True)
    ]


class EvalMarket:
    """The fixture provider, with `EXTRA_QUOTES` beside it."""

    name = "fixture"

    def __init__(self, fixtures_dir: str) -> None:
        self._fixture = FixtureProvider(fixtures_dir)
        self.quote_calls: list[list[str]] = []

    async def quotes(
        self, symbols: list[str], _markets: Any = None
    ) -> tuple[list[Quote], list[str]]:
        self.quote_calls.append(list(symbols))
        wanted = [symbol.strip().upper() for symbol in symbols]
        found = {
            quote.symbol: quote.model_copy(update={"delay_seconds": DELAY_SECONDS})
            for quote in await self._fixture.quotes(wanted)
        }
        now = datetime.now(UTC)
        for symbol in wanted:
            if symbol in EXTRA_QUOTES and symbol not in found:
                price, previous = (Decimal(v) for v in EXTRA_QUOTES[symbol])
                price_minor, previous_minor = to_minor(price, "USD"), to_minor(previous, "USD")
                found[symbol] = Quote(
                    symbol=symbol,
                    price_minor=price_minor,
                    currency="USD",
                    as_of=now.replace(second=0, microsecond=0),
                    source="fixture",
                    delay_seconds=DELAY_SECONDS,
                    previous_close_minor=previous_minor,
                    day_change_pct=round((price_minor - previous_minor) / previous_minor * 100, 4),
                )
        return [found[s] for s in wanted if s in found], [s for s in wanted if s not in found]

    async def history(self, symbol: str, days: int) -> list[DailyClose]:
        symbol = symbol.strip().upper()
        if symbol not in EXTRA_QUOTES:
            return await self._fixture.history(symbol, days)
        today = datetime.now(UTC).date()
        earliest = today - timedelta(days=days)
        previous = Decimal(EXTRA_QUOTES[symbol][1])
        return [
            DailyClose(
                symbol=symbol,
                as_of=datetime.combine(day, CLOSE_TIME),
                price_minor=to_minor(close, "USD"),
                currency="USD",
                source="fixture",
            )
            for day, close in extra_series(symbol, previous, today - timedelta(days=1))
            if day >= earliest
        ]
