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

**Which snapshot** (decision 90): the newest by `as_of` of the image's and those
a rescreen wrote to `UNIVERSE_SNAPSHOT_DIR`, and never one older than the last
load recorded - see `app/universe/loading.py`. `--universe DIR` names one
snapshot and is held to the same rule. Members the loaded snapshot does not
hold are marked `dropped`.

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
import sys
from pathlib import Path

from app.config import get_settings
from app.corpus.embedder_factory import EmbedderConfigurationError, build_embedder
from app.db import get_engine
from app.universe.loading import (
    choose_snapshot,
    last_loaded_as_of,
    load_into_database,
    volume_snapshots,
)
from app.universe.profiles import (
    DESCRIPTION_LICENSE,
    DESCRIPTION_SOURCE,
    FIXTURE_DESCRIPTION_LICENSE,
    FIXTURE_DESCRIPTION_SOURCE,
    embed_pending,
)
from app.universe.snapshot import DESCRIPTIONS_FILE


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

    settings = get_settings()
    volume = Path(settings.universe_snapshot_dir) if settings.universe_snapshot_dir else None
    candidates = (
        [args.universe] if args.universe else [default_universe(), *volume_snapshots(volume)]
    )

    with get_engine().begin() as connection:
        choice = choose_snapshot(candidates, last_loaded_as_of(connection))
        print(f"universe: {choice.reason}")
        if choice.directory is not None:
            if args.fixture:
                descriptions = fixture_descriptions()
                provenance = (FIXTURE_DESCRIPTION_SOURCE, FIXTURE_DESCRIPTION_LICENSE)
            else:
                descriptions = args.descriptions or choice.directory / DESCRIPTIONS_FILE
                provenance = (DESCRIPTION_SOURCE, DESCRIPTION_LICENSE)
            if not descriptions.exists():
                # Said on stderr and in words, because the consequence shows up
                # far away: every topic answers `unavailable` until this exists.
                print(
                    f"no descriptions at {descriptions}: nothing new can be profiled, and topics "
                    "will resolve only against profiles already in the database. Descriptions "
                    "are not committed; copy descriptions.local.jsonl into the universe "
                    "directory, run build_instrument_universe.py (half an hour or more), or "
                    "rescreen from the admin page.",
                    file=sys.stderr,
                )
            loaded = load_into_database(
                connection,
                choice.directory,
                descriptions=descriptions,
                source=provenance[0],
                license=provenance[1],
            )
            report, held = loaded.report, loaded.holdings
            print(
                f"universe as of {loaded.as_of}: {loaded.members} members, "
                f"{report.created} created, {report.text_changed} changed, "
                f"{report.unchanged} unchanged, {report.undescribed} without a description, "
                f"{report.no_currency} without a currency, {loaded.dropped} dropped"
            )
            print(
                f"etf holdings: {held.total} rows, {held.matched_by_symbol} matched by symbol, "
                f"{held.matched_by_name} by name, {held.unmatched} with no US listing, "
                f"{held.implausible} skipped as not a fraction of the fund, "
                f"{held.of_unprofiled_etf} of a fund with no profile"
            )
        if args.no_embed:
            return 0
        try:
            embedder = build_embedder(settings)
        except EmbedderConfigurationError as exc:
            print(f"not embedding: {exc}", file=sys.stderr)
            return 1
        # Run whether or not anything was loaded: a profile whose embedding
        # failed last time is healed here either way.
        embedded = asyncio.run(embed_pending(connection, embedder))
        print(f"embedded {embedded} profiles with {embedder.model}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
