"""Load the instrument universe into `instruments` / `instrument_profiles` and embed it.

    python scripts/ingest_universe.py [--universe DIR] [--no-embed]

Reads the committed membership (`data/universe/instruments.jsonl`) and this
machine's gitignored descriptions (`descriptions.local.jsonl`, written by
`build_instrument_universe.py`). Safe to repeat: an unchanged description keeps
its embedding, so a second run embeds nothing and costs nothing.

Embedding uses the configured embedder (`EMBEDDINGS_PROVIDER`), exactly as the
concept corpus does. On the fixture embedder the vectors measure shared words,
which is enough to exercise the path and useless for judging topic resolution.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from app.config import get_settings
from app.corpus.embedder_factory import EmbedderConfigurationError, build_embedder
from app.db import get_engine
from app.universe.profiles import embed_pending, load_universe
from app.universe.snapshot import load_snapshot


def default_universe() -> Path:
    return Path(get_settings().corpus_dir).parent / "universe"


def main() -> int:
    parser = argparse.ArgumentParser(description="Load and embed the instrument universe.")
    parser.add_argument("--universe", type=Path, default=None)
    parser.add_argument("--no-embed", action="store_true", help="load text, skip embedding")
    args = parser.parse_args()

    snapshot = load_snapshot(args.universe or default_universe())
    with get_engine().begin() as connection:
        report = load_universe(connection, snapshot)
        print(
            f"universe as of {snapshot.as_of}: {len(snapshot.instruments)} members, "
            f"{report.created} created, {report.text_changed} changed, "
            f"{report.unchanged} unchanged, {report.undescribed} without a description, "
            f"{report.no_currency} without a currency"
        )
        if args.no_embed:
            return 0
        try:
            embedder = build_embedder(get_settings())
        except EmbedderConfigurationError as exc:
            print(f"not embedding: {exc}", file=sys.stderr)
            return 1
        embedded = asyncio.run(embed_pending(connection, embedder))
        print(f"embedded {embedded} profiles with {embedder.model}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
