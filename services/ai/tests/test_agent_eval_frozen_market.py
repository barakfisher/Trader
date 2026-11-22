"""The frozen market's answers that need no database: movers, fetched closes, the clock.

Its reading of stored closes is `tests/integration/test_agent_eval_frozen_world_sql.py`.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

import scripts.agent_eval.frozen_market as frozen_market
from app.config import Settings
from app.models import DailyClose
from scripts.agent_eval.frozen_market import (
    MOVER_CURRENCY,
    MOVER_LISTS,
    QUOTE_LOOKBACK_DAYS,
    SOURCE,
    FrozenMarket,
    briefing_symbols,
    dump_closes,
    load_closes,
    movers_from_briefing,
)
from scripts.freeze_agent_eval_world import PACE, fetch_closes, history_days, pause_seconds

CLOCK = datetime(2026, 11, 19, 7, 21, 36, tzinfo=UTC)
BRIEFING: dict[str, Any] = {
    "movers": {
        "gainers": [{"symbol": "QLYS", "change_percent": "12.50", "price": "151.07"}],
        "losers": [{"symbol": "AAOI", "change_percent": "-8.25", "price": "30.00"}],
        "most_active": [{"symbol": "NVDA", "change_percent": "1.00", "price": "182.40"}],
    },
    "new_in_universe": [{"symbol": "ant", "name": "A new listing"}],
    "followed_topics": [
        {"topic": "uranium", "candidates": [{"symbol": "CCJ"}, {"symbol": "NVDA"}]}
    ],
}


def _close(symbol: str, days_before: int, price_minor: int) -> DailyClose:
    return DailyClose(
        symbol=symbol,
        as_of=CLOCK - timedelta(days=days_before),
        price_minor=price_minor,
        currency="USD",
        source="yfinance",
    )


@pytest.fixture
def no_listing(monkeypatch: pytest.MonkeyPatch) -> None:
    """No database: the symbol is not stored, so only fetched closes can price it."""
    monkeypatch.setattr(frozen_market, "find_listing", lambda _engine, _symbol: None)


def _market(closes: dict[str, list[DailyClose]]) -> FrozenMarket:
    return FrozenMarket(None, CLOCK, closes=closes)  # type: ignore[arg-type]


def test_movers_come_back_as_the_lists_the_briefing_showed() -> None:
    movers = movers_from_briefing(BRIEFING)
    assert [(m.list, m.symbol) for m in movers] == [
        ("gainers", "QLYS"),
        ("losers", "AAOI"),
        ("most_active", "NVDA"),
    ]
    assert {m.list for m in movers} == set(MOVER_LISTS)
    assert (movers[0].price_minor, movers[0].currency, movers[0].source) == (
        15_107,
        MOVER_CURRENCY,
        SOURCE,
    )
    assert movers[1].change_pct < 0


def test_a_briefing_with_no_movers_gives_none() -> None:
    assert movers_from_briefing({}) == []
    assert movers_from_briefing({"movers": {"note": "no movers list is available today"}}) == []


def test_the_symbols_frozen_are_every_one_the_briefing_named_once() -> None:
    assert briefing_symbols(BRIEFING) == ["QLYS", "AAOI", "NVDA", "ANT", "CCJ"]


async def test_a_quote_is_the_last_close_at_the_clock_with_the_one_before(no_listing: None) -> None:
    market = _market({"QLYS": [_close("QLYS", 2, 14_000), _close("QLYS", 1, 15_107)]})
    quotes, missing = await market.quotes(["qlys", "NOPE"])
    assert missing == ["NOPE"] and market.unpriced == ["NOPE"]
    (quote,) = quotes
    assert (quote.price_minor, quote.previous_close_minor) == (15_107, 14_000)
    assert quote.as_of == CLOCK - timedelta(days=1)
    assert quote.source == SOURCE


async def test_a_close_after_the_clock_is_never_a_price(no_listing: None) -> None:
    market = _market({"QLYS": [_close("QLYS", 1, 15_107), _close("QLYS", -1, 99_999)]})
    (quote,), _ = await market.quotes(["QLYS"])
    assert quote.price_minor == 15_107
    assert quote.previous_close_minor is None
    assert [c.price_minor for c in await market.history("QLYS", 30)] == [15_107]


async def test_a_close_older_than_the_lookback_does_not_price_a_quote(no_listing: None) -> None:
    market = _market({"QLYS": [_close("QLYS", QUOTE_LOOKBACK_DAYS + 1, 15_107)]})
    assert await market.quotes(["QLYS"]) == ([], ["QLYS"])


async def test_history_is_what_was_fetched_inside_the_window_and_says_when_none() -> None:
    market = _market({"QLYS": [_close("QLYS", 40, 1), _close("QLYS", 5, 2)]})
    assert [c.price_minor for c in await market.history("qlys", 30)] == [2]
    assert market.unpriced == []
    assert await market.history("NOPE", 30) == []
    assert market.unpriced == ["NOPE"]


def test_a_closes_file_reads_back_as_it_was_written(tmp_path: Path) -> None:
    closes = {"QLYS": [_close("QLYS", 2, 14_000), _close("QLYS", 1, 15_107)]}
    path = tmp_path / "world.closes.json"
    path.write_text(json.dumps({"closes": dump_closes(closes)}), encoding="utf-8")
    assert load_closes(path) == closes


def test_a_world_frozen_late_still_asks_for_the_whole_window_before_its_clock() -> None:
    at_once = history_days(CLOCK, CLOCK)
    assert history_days(CLOCK, CLOCK + timedelta(days=9)) == at_once + 9


class _LimitedMarket:
    """A market that answers nothing for a symbol the first time it is asked, as the
    market service does for a rate-limited call."""

    def __init__(self, closes: dict[str, list[DailyClose]], limited: set[str]) -> None:
        self._closes, self._limited = closes, set(limited)
        self.asked: list[str] = []

    async def history(self, symbol: str, _days: int) -> list[DailyClose]:
        self.asked.append(symbol)
        if symbol in self._limited:
            self._limited.discard(symbol)
            return []
        return self._closes.get(symbol, [])


async def test_a_symbol_that_came_back_empty_is_asked_again_before_it_is_written_off() -> None:
    closes = {"QLYS": [_close("QLYS", 1, 15_107)], "NVDA": [_close("NVDA", 1, 18_240)]}
    market = _LimitedMarket(closes, limited={"NVDA"})
    found, without = await fetch_closes(
        market,  # type: ignore[arg-type]
        ["QLYS", "NVDA", "NOPE"],
        CLOCK,
        CLOCK,
        pause=0,
        retry_after=0,
    )
    assert set(found) == {"QLYS", "NVDA"}
    assert without == ["NOPE"]
    assert market.asked == ["QLYS", "NVDA", "NOPE", "NVDA", "NOPE"]


async def test_a_close_after_the_clock_is_not_frozen_into_a_world() -> None:
    market = _LimitedMarket({"QLYS": [_close("QLYS", 1, 1), _close("QLYS", -1, 2)]}, set())
    found, _ = await fetch_closes(market, ["QLYS"], CLOCK, CLOCK, pause=0, retry_after=0)  # type: ignore[arg-type]
    assert [close.price_minor for close in found["QLYS"]] == [1]


def test_the_fetch_stays_under_the_provider_s_limit() -> None:
    limit = Settings(_env_file=None).provider_rate_limit_per_minute  # type: ignore[call-arg]
    calls_a_minute = 60 / pause_seconds(limit)
    assert calls_a_minute < limit
    assert calls_a_minute == pytest.approx(limit * PACE)
