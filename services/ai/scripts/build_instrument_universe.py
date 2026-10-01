"""Build the committed instrument universe from Yahoo's screener.

    python scripts/build_instrument_universe.py --cache FILE --holdings-cache FILE
        [--out DIR] [--workers N]

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

The screen, the fetches and the files are `app/universe/screener.py`, shared
with the admin's rescreen run (M8); this file is the command line around them.
`--cache` and `--holdings-cache` keep every payload already fetched, so an
interrupted build (Yahoo rate-limits long runs) resumes rather than restarting.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import yfinance as yf

from app.config import get_settings
from app.universe.screener import IncompleteFetch, build_snapshot


def default_out() -> Path:
    """`data/universe`, beside the corpus - resolved the way `run_eval.py` does."""
    return Path(get_settings().corpus_dir).parent / "universe"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--cache", type=Path, required=True, help="resumable info cache (JSONL)")
    parser.add_argument(
        "--holdings-cache", type=Path, required=True, help="resumable ETF holdings cache (JSONL)"
    )
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    out: Path = args.out or default_out()

    try:
        counts = build_snapshot(
            out,
            as_of=datetime.now(UTC).replace(microsecond=0),
            info_cache=args.cache,
            holdings_cache=args.holdings_cache,
            workers=args.workers,
            yfinance_version=yf.__version__,
        )
    except IncompleteFetch as error:
        raise SystemExit(str(error)) from error
    print(json.dumps(counts), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
