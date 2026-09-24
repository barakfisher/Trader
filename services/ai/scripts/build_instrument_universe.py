"""Build the committed instrument universe from Yahoo's screener.

    python scripts/build_instrument_universe.py [--out DIR] [--cache FILE] [--workers N]

Writes `data/universe/instruments.jsonl` (one instrument per line, sorted by
symbol, so a rebuild diffs as the listings that actually changed),
`data/universe/manifest.json` (when, by what screen, and what is missing), and
`data/universe/descriptions.local.jsonl` - the business summaries, which are
Yahoo's text and are **gitignored**, not committed (see `app/universe/snapshot.py`).

**This is an operator's tool, not part of any run.** It needs the network and
takes a while - one `info` request per instrument, a few thousand of them - and
its output is committed so that resolution, CI and the eval all read one fixed
universe. A universe that changed under the eval between two runs would make a
regression and a new listing look the same.

The rules for membership live in `app/universe/snapshot.py`, where they can be
tested; this file only fetches. `--cache` keeps every `info` payload already
fetched, so an interrupted build (Yahoo rate-limits long runs) resumes rather
than restarting.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yfinance as yf
from yfinance import EquityQuery, ETFQuery

from app.config import get_settings
from app.universe.snapshot import (
    DESCRIPTIONS_FILE,
    MANIFEST_FILE,
    MEMBERSHIP_FILE,
    MIN_SIZE_MINOR,
    PRIMARY_US_EXCHANGES,
    SCREEN,
    select,
    to_instrument,
)

PAGE = 250
#: Yahoo's screener takes whole dollars.
MIN_SIZE_DOLLARS = MIN_SIZE_MINOR // 100


def default_out() -> Path:
    """`data/universe`, beside the corpus - resolved the way `run_eval.py` does."""
    return Path(get_settings().corpus_dir).parent / "universe"


def _screen(query: Any, sort_field: str) -> list[dict[str, Any]]:
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
    equities = _screen(
        EquityQuery(
            "and",
            [
                EquityQuery("eq", ["region", "us"]),
                EquityQuery("is-in", ["exchange", *PRIMARY_US_EXCHANGES]),
                EquityQuery("gte", ["intradaymarketcap", MIN_SIZE_DOLLARS]),
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
                ETFQuery("gte", ["fundnetassets", MIN_SIZE_DOLLARS]),
            ],
        ),
        "fundnetassets",
    )
    print(f"screened {len(equities)} equities and {len(funds)} ETFs", file=sys.stderr)
    return equities + funds


def _load_cache(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    cache: dict[str, dict[str, Any]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            entry = json.loads(line)
            cache[entry["symbol"]] = entry["info"]
    return cache


def _fetch_info(symbol: str) -> dict[str, Any] | None:
    """`info` for one symbol, or None if every attempt failed.

    None is not `{}`. A failure is not cached, so the next run retries it; an
    empty payload is what Yahoo actually said and is cached like any answer.
    Caching a rate-limit failure as `{}` would record "Yahoo has no description"
    for a symbol it simply refused to answer about - permanently, and in a form
    indistinguishable from the truth.
    """
    for attempt in range(4):
        try:
            return dict(yf.Ticker(symbol).info or {})
        except Exception as exc:  # noqa: BLE001 - yfinance raises whatever requests does
            wait = 2**attempt * 5
            print(f"  {symbol}: {type(exc).__name__}, retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    return None


#: The only `info` fields the universe keeps; the rest is not cached.
_INFO_FIELDS = ("longBusinessSummary", "sector", "industry", "category")


def fetch_infos(symbols: list[str], cache_path: Path, workers: int) -> dict[str, dict[str, Any]]:
    cache = _load_cache(cache_path)
    todo = [s for s in symbols if s not in cache]
    print(f"{len(cache)} cached, {len(todo)} to fetch", file=sys.stderr)
    failed: list[str] = []
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with cache_path.open("a", encoding="utf-8") as sink, ThreadPoolExecutor(workers) as pool:
        futures = {pool.submit(_fetch_info, s): s for s in todo}
        for done, future in enumerate(as_completed(futures), 1):
            symbol = futures[future]
            payload = future.result()
            if payload is None:
                failed.append(symbol)
                continue
            info = {k: v for k, v in payload.items() if k in _INFO_FIELDS}
            cache[symbol] = info
            sink.write(json.dumps({"symbol": symbol, "info": info}) + "\n")
            sink.flush()
            if done % 100 == 0:
                print(f"  {done}/{len(todo)}", file=sys.stderr)
    if failed:
        # Refuse to write a snapshot with holes that look like data. Rerunning
        # resumes from the cache and asks only for these.
        raise SystemExit(f"{len(failed)} symbols failed to fetch; rerun to retry: {failed[:20]}")
    return cache


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--cache", type=Path, required=True, help="resumable info cache (JSONL)")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    out: Path = args.out or default_out()

    as_of = datetime.now(UTC).replace(microsecond=0)
    screened = screen_market()
    chosen = select(screened)
    infos = fetch_infos([str(q["symbol"]) for q in chosen], args.cache, args.workers)
    instruments = [to_instrument(q, infos.get(str(q["symbol"]), {})) for q in chosen]

    out.mkdir(parents=True, exist_ok=True)
    with (out / MEMBERSHIP_FILE).open("w", encoding="utf-8") as sink:
        for instrument in instruments:
            sink.write(json.dumps(instrument.membership_json(), sort_keys=True) + "\n")
    with (out / DESCRIPTIONS_FILE).open("w", encoding="utf-8") as sink:
        for instrument in instruments:
            if instrument.description is not None:
                row = {"symbol": instrument.symbol, "description": instrument.description}
                sink.write(json.dumps(row, ensure_ascii=False) + "\n")

    undescribed = sorted(i.symbol for i in instruments if i.description is None)
    manifest = {
        "as_of": as_of.isoformat().replace("+00:00", "Z"),
        "source": "yahoo finance screener + Ticker.info (yfinance " + yf.__version__ + ")",
        "screen": SCREEN,
        "counts": {
            "screened": len(screened),
            "kept": len(instruments),
            "equities": sum(i.asset_class == "equity" for i in instruments),
            "etfs": sum(i.asset_class == "etf" for i in instruments),
            "dropped_preferred_or_duplicate_listing": len(screened) - len(chosen),
            "without_description": len(undescribed),
        },
        "without_description": undescribed,
    }
    (out / MANIFEST_FILE).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest["counts"]), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
