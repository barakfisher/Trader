"""Build a universe snapshot from Yahoo's screener: the screen, the fetches, the files.

Two callers, one implementation. `scripts/build_instrument_universe.py` is the
operator's tool that produced the committed snapshot; the rescreen run (M8,
`app/universe/rescreen.py`) builds a new one into a writable volume. The rules
for membership live in `snapshot.py`, where they are tested; this module only
fetches and writes.

**Resumable by cache.** Every `info` payload and every fund's holdings are
appended to a JSONL cache as they arrive, so a build that is killed - by Yahoo
rate-limiting a long run, or by the process it runs in being replaced - resumes
from where it stopped instead of restarting. **A failure is never cached**: an
empty payload is what Yahoo said and is kept; an exception is not an answer, and
caching it as `{}` would record "Yahoo has no description" for a symbol it
simply refused to answer about - permanently, and in a form indistinguishable
from the truth.

**Never a snapshot with holes.** If anything still failed after retries, the
build raises `IncompleteFetch` and writes nothing; rerunning resumes from the
cache and asks only for what is missing.

Measured 2026-10-01 against the live screener, 4 workers: the screen in 19 s
(5,427 rows), 100 `info` fetches in 8.9 s, 40 holdings fetches in 1.4 s - about
ten minutes if Yahoo never rate-limited. It does: the first full run was
throttled within two minutes and failed after 28 on 64 symbols, and two
resumed retries finished it. Expect half an hour and a retry.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from app.core.logging import get_logger
from app.universe.snapshot import (
    DESCRIPTIONS_FILE,
    ETF_HOLDINGS_FILE,
    MANIFEST_FILE,
    MEMBERSHIP_FILE,
    MIN_EQUITY_SIZE_MINOR,
    MIN_ETF_SIZE_MINOR,
    PRIMARY_US_EXCHANGES,
    SCREEN,
    select,
    to_instrument,
)

log = get_logger("universe.screener")

PAGE = 250
#: Yahoo's words for "this fund reports no holdings" - an answer, not a failure.
NO_FUND_DATA = "No Fund data found"
#: Yahoo's screener takes whole dollars.
MIN_EQUITY_SIZE_DOLLARS = MIN_EQUITY_SIZE_MINOR // 100
MIN_ETF_SIZE_DOLLARS = MIN_ETF_SIZE_MINOR // 100
#: The only `info` fields the universe keeps; the rest is not cached.
INFO_FIELDS = ("longBusinessSummary", "sector", "industry", "category")
#: Attempts per symbol before it counts as failed; waits 5, 10, 20 s between.
ATTEMPTS = 4

#: Cache file names, for a caller that keeps both in one directory.
INFO_CACHE = "info.jsonl"
HOLDINGS_CACHE = "holdings.jsonl"


class IncompleteFetch(Exception):
    """Some symbols failed after every retry. Nothing was written; rerun to resume."""

    def __init__(self, what: str, symbols: list[str]) -> None:
        super().__init__(f"{len(symbols)} {what} failed to fetch; rerun to retry: {symbols[:20]}")
        self.symbols = symbols


def _screen(query: Any, sort_field: str) -> list[dict[str, Any]]:
    import yfinance as yf

    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = yf.screen(query, size=PAGE, offset=offset, sortField=sort_field, sortAsc=False)
        rows.extend(page["quotes"])
        offset += PAGE
        if not page["quotes"] or offset >= page["total"]:
            return rows
        time.sleep(0.3)


def screen_market() -> list[dict[str, Any]]:
    from yfinance import EquityQuery, ETFQuery

    equities = _screen(
        EquityQuery(
            "and",
            [
                EquityQuery("eq", ["region", "us"]),
                EquityQuery("is-in", ["exchange", *PRIMARY_US_EXCHANGES]),
                EquityQuery("gte", ["intradaymarketcap", MIN_EQUITY_SIZE_DOLLARS]),
            ],
        ),
        "intradaymarketcap",
    )
    funds = _screen(
        ETFQuery(
            "and",
            [
                ETFQuery("eq", ["region", "us"]),
                ETFQuery("is-in", ["exchange", *PRIMARY_US_EXCHANGES]),
                ETFQuery("gte", ["fundnetassets", MIN_ETF_SIZE_DOLLARS]),
            ],
        ),
        "fundnetassets",
    )
    log.info("universe.screened", equities=len(equities), etfs=len(funds))
    return equities + funds


def _fetch_info(symbol: str) -> dict[str, Any] | None:
    """`info` for one symbol, or None if every attempt failed (see the module docstring)."""
    import yfinance as yf

    for attempt in range(ATTEMPTS):
        try:
            return dict(yf.Ticker(symbol).info or {})
        except Exception as exc:  # noqa: BLE001 - yfinance raises whatever requests does
            wait = 2**attempt * 5
            log.warning("universe.info_retry", symbol=symbol, error=type(exc).__name__, wait=wait)
            time.sleep(wait)
    return None


def _fetch_holdings(symbol: str) -> list[dict[str, Any]] | None:
    """An ETF's top holdings as rows, or None if every attempt failed.

    An empty list is Yahoo saying the fund reports none, and is cached; None is
    a failure and is not. The two arrive as the same exception type - an
    exchange-traded note like FNGU has no holdings and raises `YFDataException`
    exactly as a transient error does - so the message decides: "No Fund data
    found" is an answer, anything else is retried.
    """
    import yfinance as yf

    for attempt in range(ATTEMPTS):
        try:
            frame = yf.Ticker(symbol).funds_data.top_holdings
            return [
                {
                    "etf": symbol,
                    "position": position,
                    "symbol": str(held),
                    "name": None if row.get("Name") is None else str(row["Name"]),
                    "weight": str(Decimal(str(row["Holding Percent"]))),
                }
                for position, (held, row) in enumerate(frame.iterrows(), 1)
            ]
        except Exception as exc:  # noqa: BLE001 - yfinance raises whatever requests does
            if NO_FUND_DATA in str(exc):
                return []
            wait = 2**attempt * 5
            log.warning("universe.holdings_retry", etf=symbol, error=type(exc).__name__, wait=wait)
            time.sleep(wait)
    return None


def _read_cache(path: Path, key: str, value: str) -> dict[str, Any]:
    if not path.exists():
        return {}
    cache: dict[str, Any] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            entry = json.loads(line)
            cache[entry[key]] = entry[value]
    return cache


def _fetch_all(
    todo: list[str],
    fetch: Callable[[str], Any],
    keep: Callable[[str, Any], tuple[dict[str, Any], Any]],
    sink_path: Path,
    workers: int,
) -> tuple[dict[str, Any], list[str]]:
    """Fetch `todo` in parallel, appending each answer to the cache as it arrives.

    `keep` turns a payload into its cache line and the value to return.
    """
    fetched: dict[str, Any] = {}
    failed: list[str] = []
    sink_path.parent.mkdir(parents=True, exist_ok=True)
    with sink_path.open("a", encoding="utf-8") as sink, ThreadPoolExecutor(workers) as pool:
        futures = {pool.submit(fetch, symbol): symbol for symbol in todo}
        for future in as_completed(futures):
            symbol = futures[future]
            payload = future.result()
            if payload is None:
                failed.append(symbol)
                continue
            line, fetched[symbol] = keep(symbol, payload)
            sink.write(json.dumps(line) + "\n")
            sink.flush()
    return fetched, failed


def fetch_infos(symbols: list[str], cache_path: Path, workers: int) -> dict[str, dict[str, Any]]:
    cache = _read_cache(cache_path, "symbol", "info")
    todo = [s for s in symbols if s not in cache]
    log.info("universe.infos", cached=len(cache), to_fetch=len(todo))

    def keep(symbol: str, payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        info = {k: v for k, v in payload.items() if k in INFO_FIELDS}
        return {"symbol": symbol, "info": info}, info

    fetched, failed = _fetch_all(todo, _fetch_info, keep, cache_path, workers)
    if failed:
        raise IncompleteFetch("symbols", failed)
    return {**cache, **fetched}


def fetch_holdings(etfs: list[str], cache_path: Path, workers: int) -> list[dict[str, Any]]:
    cache = _read_cache(cache_path, "etf", "holdings")
    todo = [s for s in etfs if s not in cache]
    log.info("universe.holdings", cached=len(cache), to_fetch=len(todo))

    def keep(etf: str, rows: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        return {"etf": etf, "holdings": rows}, rows

    fetched, failed = _fetch_all(todo, _fetch_holdings, keep, cache_path, workers)
    if failed:
        raise IncompleteFetch("ETFs' holdings", failed)
    cache.update(fetched)
    return [row for etf in sorted(etfs) for row in cache[etf]]


def build_snapshot(
    out: Path,
    *,
    as_of: datetime,
    info_cache: Path,
    holdings_cache: Path,
    workers: int,
    yfinance_version: str,
) -> dict[str, int]:
    """Screen, fetch and write a complete snapshot into `out`. Returns its counts.

    Writes the four files the loader reads. The caller decides where `out` is
    and when it becomes visible: the rescreen builds into a temporary directory
    and renames it into place, so a half-written snapshot never exists.
    """
    screened = screen_market()
    chosen = select(screened)
    infos = fetch_infos([str(q["symbol"]) for q in chosen], info_cache, workers)
    instruments = [to_instrument(q, infos.get(str(q["symbol"]), {})) for q in chosen]
    etfs = [i.symbol for i in instruments if i.asset_class == "etf"]
    holdings = fetch_holdings(etfs, holdings_cache, workers)

    out.mkdir(parents=True, exist_ok=True)
    with (out / MEMBERSHIP_FILE).open("w", encoding="utf-8") as sink:
        for instrument in instruments:
            sink.write(json.dumps(instrument.membership_json(), sort_keys=True) + "\n")
    with (out / DESCRIPTIONS_FILE).open("w", encoding="utf-8") as sink:
        for instrument in instruments:
            if instrument.description is not None:
                row = {"symbol": instrument.symbol, "description": instrument.description}
                sink.write(json.dumps(row, ensure_ascii=False) + "\n")
    with (out / ETF_HOLDINGS_FILE).open("w", encoding="utf-8") as sink:
        for row in holdings:
            sink.write(json.dumps(row, sort_keys=True) + "\n")

    undescribed = sorted(i.symbol for i in instruments if i.description is None)
    counts = {
        "screened": len(screened),
        "kept": len(instruments),
        "equities": sum(i.asset_class == "equity" for i in instruments),
        "etfs": sum(i.asset_class == "etf" for i in instruments),
        "dropped_preferred_or_duplicate_listing": len(screened) - len(chosen),
        "without_description": len(undescribed),
        "etf_holdings": len(holdings),
        "etfs_reporting_no_holdings": len(set(etfs) - {row["etf"] for row in holdings}),
    }
    manifest = {
        "as_of": as_of.isoformat().replace("+00:00", "Z"),
        "source": f"yahoo finance screener + Ticker.info (yfinance {yfinance_version})",
        "screen": SCREEN,
        "counts": counts,
        "without_description": undescribed,
    }
    # Last, so a directory with a manifest is a complete snapshot.
    (out / MANIFEST_FILE).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return counts
