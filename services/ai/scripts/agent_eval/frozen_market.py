"""The market of a frozen world: prices as they stood when the dump was taken.

A scan asks the market three things, and none of the answers is in a dump as such:

- **Quotes** come live from a provider. Here a quote is the last stored close at or
  before the world's clock, with the close before it as the previous close. Every
  world was dumped with the US market closed, so that close *is* the price then.
- **History** is backfilled from a provider the first time an agent asks about a
  symbol, so production stores closes only for what was already asked about:
  measured on the dump of 2026-11-19, 29 instruments had closes and 13 of the 15
  movers in the newest briefing had none. A frozen world that answered "no closes"
  for a mover would make every scan pass on it. So the closes of the briefing's
  symbols are fetched once, when the world is frozen (`freeze_agent_eval_world.py`),
  and kept in a file beside the dump; `history` answers from that file and the
  tools' own backfill stores them, as it would on production (D426).
- **Movers** are a provider's list of the day. Here they are the lists of the
  agent's own newest stored briefing: what its last real scan was shown.

Anything else is unpriced, and says so: nothing is invented (CLAUDE.md, guideline 7).
A scan that asks for a price this world lacks is counted in the run's report.

Duck-typed against `MarketDataService`, as the tools' tests' `ScriptedMarket` is.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.agents.tools import find_listing
from app.analysis.quote_history import load_daily_closes
from app.core.money import to_minor
from app.models import DailyClose, Mover, MoverList, Quote

#: What the stored series and the tools call the lists.
MOVER_LISTS: tuple[MoverList, ...] = ("gainers", "losers", "most_active")
#: The universe is USD-listed, and a stored briefing keeps a mover's price without its currency.
MOVER_CURRENCY = "USD"
#: `Quote.source` and `Mover.source` of everything this market answers.
SOURCE = "frozen"
#: Calendar days searched for the last two closes: a long weekend and a holiday beside it.
QUOTE_LOOKBACK_DAYS = 10


def movers_from_briefing(briefing: Mapping[str, Any]) -> list[Mover]:
    """The movers a stored briefing showed, as the provider's list they were cut from."""
    section = briefing.get("movers")
    if not isinstance(section, Mapping):
        return []
    movers: list[Mover] = []
    for kind in MOVER_LISTS:
        for entry in section.get(kind) or []:
            movers.append(
                Mover(
                    symbol=str(entry["symbol"]),
                    list=kind,
                    change_pct=float(Decimal(str(entry["change_percent"]))),
                    price_minor=to_minor(Decimal(str(entry["price"])), MOVER_CURRENCY),
                    currency=MOVER_CURRENCY,
                    source=SOURCE,
                )
            )
    return movers


def briefing_symbols(briefing: Mapping[str, Any]) -> list[str]:
    """Every symbol a stored briefing names outside the holdings: the ones an agent
    is most likely to ask about, and so the ones a world's closes are fetched for."""
    symbols = [mover.symbol for mover in movers_from_briefing(briefing)]
    for key in ("new_in_universe", "upcoming_ipos"):
        for entry in briefing.get(key) or []:
            if isinstance(entry, Mapping) and isinstance(entry.get("symbol"), str):
                symbols.append(entry["symbol"])
    for topic in briefing.get("followed_topics") or []:
        for entry in (topic.get("candidates") or []) if isinstance(topic, Mapping) else []:
            if isinstance(entry, Mapping) and isinstance(entry.get("symbol"), str):
                symbols.append(entry["symbol"])
    return list(dict.fromkeys(symbol.strip().upper() for symbol in symbols if symbol.strip()))


def newest_briefing(engine: Engine, agent_id: str, as_of: datetime) -> dict[str, Any] | None:
    """The agent's newest finished scan's briefing at or before the world's clock."""
    with engine.connect() as connection:
        briefing = connection.execute(
            text(
                """
                SELECT briefing
                  FROM agent_scans
                 WHERE agent_id = CAST(:agent AS uuid) AND finished_at IS NOT NULL
                   AND started_at <= :as_of AND refreshes_proposal_id IS NULL
                 ORDER BY started_at DESC
                 LIMIT 1
                """
            ),
            {"agent": agent_id, "as_of": as_of},
        ).scalar_one_or_none()
    return briefing if isinstance(briefing, dict) else None


def dump_closes(closes: Mapping[str, list[DailyClose]]) -> dict[str, list[dict[str, Any]]]:
    return {
        symbol: [close.model_dump(mode="json") for close in series]
        for symbol, series in sorted(closes.items())
    }


def load_closes(path: Path) -> dict[str, list[DailyClose]]:
    """The closes file a freeze wrote: per symbol, oldest first."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {
        symbol.upper(): sorted(
            (DailyClose.model_validate(close) for close in series), key=lambda c: c.as_of
        )
        for symbol, series in raw.get("closes", {}).items()
    }


class FrozenMarket:
    """Quotes, history and movers of one world at its clock. Makes no network call."""

    name = SOURCE

    def __init__(
        self,
        engine: Engine,
        as_of: datetime,
        *,
        closes: Mapping[str, list[DailyClose]] | None = None,
        movers: list[Mover] | None = None,
    ) -> None:
        self._engine = engine
        self._as_of = as_of
        self._closes = dict(closes or {})
        self._movers = list(movers or [])
        #: Symbols asked for that this world has no price for, in the order asked.
        self.unpriced: list[str] = []

    async def movers(self) -> list[Mover]:
        return list(self._movers)

    def _fetched(self, symbol: str, since: datetime) -> list[DailyClose]:
        return [
            close for close in self._closes.get(symbol, []) if since <= close.as_of <= self._as_of
        ]

    def _last_two(self, symbol: str) -> list[tuple[datetime, int, str]]:
        """The last two closes at or before the clock, oldest first: stored, else fetched."""
        listing = find_listing(self._engine, symbol)
        if listing is not None:
            with self._engine.connect() as connection:
                stored = load_daily_closes(
                    connection, listing.instrument_id, days=QUOTE_LOOKBACK_DAYS, now=self._as_of
                )
            if stored:
                return [(p.as_of, p.price_minor, p.currency) for p in stored[-2:]]
        fetched = self._fetched(symbol, self._as_of - timedelta(days=QUOTE_LOOKBACK_DAYS))
        return [(c.as_of, c.price_minor, c.currency) for c in fetched[-2:]]

    async def quotes(
        self, symbols: list[str], _markets: Any = None
    ) -> tuple[list[Quote], list[str]]:
        quotes: list[Quote] = []
        missing: list[str] = []
        for symbol in dict.fromkeys(s.strip().upper() for s in symbols):
            closes = self._last_two(symbol)
            if not closes:
                missing.append(symbol)
                self.unpriced.append(symbol)
                continue
            as_of, price_minor, currency = closes[-1]
            previous = closes[-2][1] if len(closes) == 2 else None
            quotes.append(
                Quote(
                    symbol=symbol,
                    price_minor=price_minor,
                    currency=currency,
                    as_of=as_of,
                    source=SOURCE,
                    previous_close_minor=previous,
                    day_change_pct=(
                        round((price_minor - previous) / previous * 100, 4) if previous else None
                    ),
                )
            )
        return quotes, missing

    async def history(self, symbol: str, days: int) -> list[DailyClose]:
        symbol = symbol.strip().upper()
        fetched = self._fetched(symbol, self._as_of - timedelta(days=days))
        if not fetched:
            self.unpriced.append(symbol)
        return fetched
