"""Which universe snapshot to load, and loading it - for the startup loader and the rescreen.

Two places hold snapshots once an installation has rescreened (decision 90):
the image (the committed snapshot, plus this machine's descriptions mounted
over it) and the writable volume the rescreen writes to. The startup loader
runs on every stack start, so the rule for choosing between them is what
decides whether a rescreen survives a restart:

- **the newest by `as_of`, wherever it is**, so a rescreen's snapshot wins over
  the older one in the image;
- **never one older than the last load recorded** in `universe_loads`. Without
  this an installation whose volume was lost would quietly load the image's
  quarter-old snapshot over a fresher database: members re-added, drops undone,
  the admin's last rescreen silently reverted. It loads nothing instead, and
  says so.

Loading is the same either way: profiles written (`load_universe`), members the
snapshot no longer holds marked `dropped`, ETF holdings replaced, and the
loader's own account recorded for the admin page (decision 86).
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.universe.loads import load_record, record_load
from app.universe.profiles import (
    HoldingsReport,
    LoadReport,
    load_holdings,
    load_universe,
    mark_dropped,
)
from app.universe.snapshot import DESCRIPTIONS_FILE, MANIFEST_FILE, load_snapshot, read_holdings

#: Where a rescreen writes complete snapshots, under the snapshot volume.
SNAPSHOTS_SUBDIR = "snapshots"


def snapshot_as_of(directory: Path) -> datetime:
    manifest = json.loads((directory / MANIFEST_FILE).read_text(encoding="utf-8"))
    return datetime.fromisoformat(str(manifest["as_of"]).replace("Z", "+00:00"))


def volume_snapshots(volume: Path | None) -> list[Path]:
    """Every complete snapshot in the volume: a directory with a manifest.

    The manifest is written last and a snapshot is renamed into place only once
    complete, so a directory without one is a build that never finished - and
    a dot-directory is one still in progress.
    """
    if volume is None:
        return []
    root = volume / SNAPSHOTS_SUBDIR
    if not root.is_dir():
        return []
    return sorted(
        path
        for path in root.iterdir()
        if path.is_dir() and not path.name.startswith(".") and (path / MANIFEST_FILE).is_file()
    )


def newest_snapshot(candidates: Iterable[Path]) -> Path | None:
    present = [path for path in candidates if (path / MANIFEST_FILE).is_file()]
    return max(present, key=snapshot_as_of, default=None)


def last_loaded_as_of(connection: Connection) -> datetime | None:
    return connection.execute(text("SELECT max(snapshot_as_of) FROM universe_loads")).scalar()


@dataclass(frozen=True, slots=True)
class Choice:
    #: The snapshot to load, or None when nothing should be loaded.
    directory: Path | None
    #: Why, in words, for the loader's output and the rescreen's stats.
    reason: str


def choose_snapshot(candidates: Iterable[Path], last_loaded: datetime | None) -> Choice:
    newest = newest_snapshot(candidates)
    if newest is None:
        return Choice(None, "no snapshot found")
    as_of = snapshot_as_of(newest)
    if last_loaded is not None and as_of < last_loaded:
        return Choice(
            None,
            f"the newest snapshot ({as_of.isoformat()}, {newest}) is older than the last one "
            f"loaded ({last_loaded.isoformat()}); loading it would undo a rescreen",
        )
    return Choice(newest, f"snapshot of {as_of.isoformat()} from {newest}")


@dataclass(frozen=True, slots=True)
class LoadSummary:
    as_of: str
    members: int
    report: LoadReport
    holdings: HoldingsReport
    dropped: int


def load_into_database(
    connection: Connection,
    directory: Path,
    *,
    descriptions: Path | None,
    source: str,
    license: str,  # noqa: A002 - the column's name
) -> LoadSummary:
    """Load one snapshot in the caller's transaction and record the load."""
    snapshot = load_snapshot(directory, descriptions or directory / DESCRIPTIONS_FILE)
    report = load_universe(connection, snapshot, source=source, license=license)
    dropped = mark_dropped(connection, {member.symbol for member in snapshot.instruments})
    # After the profiles, because a holding can only match a profiled instrument.
    holding_rows = read_holdings(directory)
    held = load_holdings(connection, holding_rows, as_of=snapshot.as_of)
    record_load(
        connection,
        snapshot_as_of=snapshot.as_of,
        source=source,
        manifest=json.loads((directory / MANIFEST_FILE).read_text(encoding="utf-8")),
        record={
            **load_record(
                members=len(snapshot.instruments),
                holding_rows=len(holding_rows),
                report=report,
                holdings=held,
            ),
            "dropped": dropped,
        },
    )
    return LoadSummary(snapshot.as_of, len(snapshot.instruments), report, held, dropped)
