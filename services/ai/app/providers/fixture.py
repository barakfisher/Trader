"""Offline provider backed by JSON fixtures.

This is what CI, the test suite and the zero-API-key demo run on. It is a real
provider implementation, not a mock: the same code path, cache and chain logic
apply, which is what makes the demo trustworthy.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from app.core.logging import get_logger
from app.core.money import to_minor
from app.core.observation_time import observed_at
from app.models import FxRate, Instrument, InstrumentResolution, Quote

log = get_logger("provider.fixture")


class FixtureProvider:
    name = "fixture"
    delay_seconds = 0
    # Fixture prices are constant, so every read within a window really is the
    # same observation. Five minutes keeps the demo's price history sparse and
    # honest instead of adding a row per page refresh.
    quote_granularity_seconds = 300

    def __init__(self, fixtures_dir: str) -> None:
        self._dir = Path(fixtures_dir)
        self._instruments: dict[str, dict] = {}
        self._prices: dict[str, dict] = {}
        self._fx: dict[str, str] = {}
        self._load()

    def _load(self) -> None:
        instruments_path = self._dir / "instruments.json"
        quotes_path = self._dir / "quotes.json"
        if not instruments_path.exists() or not quotes_path.exists():
            log.warning("fixture.missing_files", directory=str(self._dir))
            return
        instruments = json.loads(instruments_path.read_text())
        self._instruments = {item["symbol"].upper(): item for item in instruments}
        quotes = json.loads(quotes_path.read_text())
        self._prices = {key.upper(): value for key, value in quotes.get("prices", {}).items()}
        self._fx = {key.upper(): value for key, value in quotes.get("fx", {}).items()}
        log.info("fixture.loaded", instruments=len(self._instruments), prices=len(self._prices))

    async def quotes(self, symbols: list[str]) -> list[Quote]:
        as_of = observed_at(datetime.now(UTC), self.quote_granularity_seconds)
        results: list[Quote] = []
        for symbol in symbols:
            entry = self._prices.get(symbol.upper())
            if entry is None:
                continue
            currency = entry.get("currency", "USD")
            price_minor = to_minor(Decimal(str(entry["price"])), currency)
            previous_minor = (
                to_minor(Decimal(str(entry["previous_close"])), currency)
                if entry.get("previous_close") is not None
                else None
            )
            day_change_pct = None
            if previous_minor:
                day_change_pct = round((price_minor - previous_minor) / previous_minor * 100, 4)
            results.append(
                Quote(
                    symbol=symbol.upper(),
                    price_minor=price_minor,
                    currency=currency,
                    as_of=as_of,
                    source=self.name,
                    delay_seconds=self.delay_seconds,
                    previous_close_minor=previous_minor,
                    day_change_pct=day_change_pct,
                )
            )
        return results

    async def resolve(self, query: str) -> InstrumentResolution:
        key = query.strip().upper()
        exact = self._instruments.get(key)
        if exact:
            return InstrumentResolution(
                query=query,
                resolved=Instrument(source=self.name, **exact),
                confidence=1.0,
                reason="exact symbol match in fixture set",
            )
        needle = query.strip().lower()
        candidates = [
            Instrument(source=self.name, **item)
            for item in self._instruments.values()
            if needle and needle in (item.get("name") or "").lower()
        ][:5]
        return InstrumentResolution(
            query=query,
            candidates=candidates,
            confidence=0.5 if candidates else 0.0,
            reason="name substring match" if candidates else "not present in fixture set",
        )

    async def fx_rate(self, base: str, quote: str) -> FxRate | None:
        if base.upper() == quote.upper():
            return FxRate(
                base=base.upper(),
                quote=quote.upper(),
                rate="1",
                as_of=observed_at(datetime.now(UTC), self.quote_granularity_seconds),
                source=self.name,
            )
        rate = self._fx.get(f"{base.upper()}{quote.upper()}")
        if rate is None:
            return None
        return FxRate(
            base=base.upper(),
            quote=quote.upper(),
            rate=str(rate),
            as_of=observed_at(datetime.now(UTC), self.quote_granularity_seconds),
            source=self.name,
        )
