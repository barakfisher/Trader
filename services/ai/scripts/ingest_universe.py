"""Load the instrument universe into `instruments` / `instrument_profiles` and embed it.

    python scripts/ingest_universe.py [--universe DIR] [--descriptions FILE | --fixture]
                                      [--no-embed]

Reads the committed membership (`data/universe/instruments.jsonl`) and this
machine's gitignored descriptions (`descriptions.local.jsonl`, written by
`build_instrument_universe.py`), then the committed ETF holdings, matched to the
profiled instruments. Safe to repeat: an unchanged description keeps
its embedding, so a second run embeds nothing and costs nothing.

The compose `universe` service runs this on every stack start, the way the
`corpus` service runs the concept ingester. **No descriptions file is not a
failure**: it exits 0 having loaded nothing new, because that is the normal
state of a fresh clone (descriptions are not committed), and `POST
/topics/resolve` then answers `unavailable` with `universe.state` saying why.
It never deletes a profile, so a run without the file leaves an existing
universe exactly as it was.

`--fixture` loads the eleven hand-written descriptions in
`data/fixtures/universe/` instead, recorded with a fixture source and licence.
That is for CI, which has no Yahoo text; never load it into a database used for
real topics.

Embedding uses the configured embedder (`EMBEDDINGS_PROVIDER`), exactly as the
concept corpus does. On the fixture embedder the vectors measure shared words,
which is enough to exercise the path and useless for judging topic resolution.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from app.config import get_settings
from app.corpus.embedder_factory import EmbedderConfigurationError, build_embedder
from app.db import get_engine
from app.universe.loads import load_record, record_load
from app.universe.profiles import (
    DESCRIPTION_LICENSE,
    DESCRIPTION_SOURCE,
    FIXTURE_DESCRIPTION_LICENSE,
    FIXTURE_DESCRIPTION_SOURCE,
    embed_pending,
    load_holdings,
    load_universe,
)
from app.universe.snapshot import DESCRIPTIONS_FILE, MANIFEST_FILE, load_snapshot, read_holdings


def default_universe() -> Path:
    return Path(get_settings().corpus_dir).parent / "universe"


def fixture_descriptions() -> Path:
    return Path(get_settings().fixtures_dir) / "universe" / "descriptions.jsonl"


def main() -> int:
    parser = argparse.ArgumentParser(description="Load and embed the instrument universe.")
    parser.add_argument("--universe", type=Path, default=None)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--descriptions", type=Path, default=None, help="descriptions file")
    source.add_argument(
        "--fixture", action="store_true", help="load the hand-written CI descriptions"
    )
    parser.add_argument("--no-embed", action="store_true", help="load text, skip embedding")
    args = parser.parse_args()

    directory = args.universe or default_universe()
    if args.fixture:
        descriptions = fixture_descriptions()
        provenance = (FIXTURE_DESCRIPTION_SOURCE, FIXTURE_DESCRIPTION_LICENSE)
    else:
        descriptions = args.descriptions or directory / DESCRIPTIONS_FILE
        provenance = (DESCRIPTION_SOURCE, DESCRIPTION_LICENSE)
    if not descriptions.exists():
        # Said on stderr and in words, because the consequence shows up far
        # away: every topic answers `unavailable` until this file exists.
        print(
            f"no descriptions at {descriptions}: nothing new can be profiled, and topics "
            "will resolve only against profiles already in the database. Descriptions are "
            "not committed; copy descriptions.local.jsonl into the universe directory, or "
            "run build_instrument_universe.py (about an hour).",
            file=sys.stderr,
        )
    snapshot = load_snapshot(directory, descriptions)
    with get_engine().begin() as connection:
        report = load_universe(connection, snapshot, source=provenance[0], license=provenance[1])
        print(
            f"universe as of {snapshot.as_of}: {len(snapshot.instruments)} members, "
            f"{report.created} created, {report.text_changed} changed, "
            f"{report.unchanged} unchanged, {report.undescribed} without a description, "
            f"{report.no_currency} without a currency"
        )
        # After the profiles, because a holding can only match a profiled instrument.
        holding_rows = read_holdings(directory)
        held = load_holdings(connection, holding_rows, as_of=snapshot.as_of)
        print(
            f"etf holdings: {held.total} rows, {held.matched_by_symbol} matched by symbol, "
            f"{held.matched_by_name} by name, {held.unmatched} with no US listing, "
            f"{held.implausible} skipped as not a fraction of the fund, "
            f"{held.of_unprofiled_etf} of a fund with no profile"
        )
        # What this load found, beside the manifest it read: the admin page
        # reconciles the database against these, not against a re-derivation.
        record_load(
            connection,
            snapshot_as_of=snapshot.as_of,
            source=provenance[0],
            manifest=json.loads((directory / MANIFEST_FILE).read_text(encoding="utf-8")),
            record=load_record(
                members=len(snapshot.instruments),
                holding_rows=len(holding_rows),
                report=report,
                holdings=held,
            ),
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
