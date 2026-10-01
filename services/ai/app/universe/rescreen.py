"""The universe rescreen run: build a new snapshot, load it, finish the run (M8, decision 90).

The orchestrator claims the `runs` row - one trigger path for a button and a
CronJob, one run key, `universe-rescreen:<date>` - and hands its id here. This
runs in the background of the AI service, because a rescreen takes half an hour
or more once Yahoo rate-limits it, and **finishes the run row
itself**: the request that started it was answered long ago.

While it works it writes `runs.heartbeat_at` every `HEARTBEAT_SECONDS`, from the
event loop rather than from the fetching thread, so the heartbeat says "this
process is alive" and nothing else. A process that dies stops heartbeating, and
only then may the orchestrator reclaim the run and start it again; the fetch
caches in the volume make that second attempt resume rather than restart.

The new snapshot is built in a dot-directory, loaded from there, and renamed
into place only once that load has committed. The startup loader takes the
newest snapshot it finds, so a snapshot published before its load succeeded
would fail the loader on every deploy - which the first real rescreen showed,
when a holding's weight broke the load after the rename.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import shutil
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.core.logging import get_logger
from app.corpus.embeddings import BaseEmbedder
from app.universe.loading import SNAPSHOTS_SUBDIR, load_into_database
from app.universe.profiles import DESCRIPTION_LICENSE, DESCRIPTION_SOURCE, embed_pending
from app.universe.screener import (
    HOLDINGS_CACHE,
    INFO_CACHE,
    IncompleteFetch,
    build_snapshot,
)

log = get_logger("universe.rescreen")

#: How often a running rescreen says it is alive.
HEARTBEAT_SECONDS = 30
#: The fetch caches, under the volume. One set, reused by every attempt until a
#: rescreen succeeds and deletes it.
CACHE_SUBDIR = "cache"
#: A cache older than this is discarded rather than resumed: a resumed build
#: should be finishing *this* rescreen, not stitching in last month's answers.
CACHE_MAX_AGE_SECONDS = 24 * 60 * 60
#: Written when a cache is started, so its age is its own and not the age of
#: whichever file was appended to last.
_CACHE_STARTED = "started"


def _snapshot_name(as_of: datetime) -> str:
    """`2026-10-01T00-12-07Z`: sorts by time and is a valid name on every filesystem."""
    return as_of.strftime("%Y-%m-%dT%H-%M-%SZ")


def _fresh_cache(volume: Path, now: float) -> Path:
    cache = volume / CACHE_SUBDIR
    marker = cache / _CACHE_STARTED
    if marker.is_file() and now - marker.stat().st_mtime > CACHE_MAX_AGE_SECONDS:
        shutil.rmtree(cache)
    if not marker.is_file():
        cache.mkdir(parents=True, exist_ok=True)
        marker.touch()
    return cache


def _heartbeat(engine: Engine, run_id: str) -> None:
    with engine.begin() as connection:
        connection.execute(
            text("UPDATE runs SET heartbeat_at = now() WHERE id = :id AND status = 'running'"),
            {"id": run_id},
        )


def finish(engine: Engine, run_id: str, status: str, stats: dict[str, Any]) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE runs SET status = :status, finished_at = now(), heartbeat_at = now(), "
                "stats = CAST(:stats AS jsonb) WHERE id = :id"
            ),
            {"id": run_id, "status": status, "stats": json.dumps(stats)},
        )


async def _beat(engine: Engine, run_id: str) -> None:
    while True:
        try:
            await asyncio.to_thread(_heartbeat, engine, run_id)
        except Exception as error:  # noqa: BLE001 - a missed beat is not a failed rescreen
            log.warning("universe.rescreen_heartbeat_failed", run_id=run_id, error=str(error))
        await asyncio.sleep(HEARTBEAT_SECONDS)


async def run_rescreen(
    run_id: str,
    *,
    volume: Path,
    engine: Engine,
    embedder: BaseEmbedder,
    workers: int = 4,
) -> str:
    """Build, load and embed a new snapshot; finish run `run_id`. Returns the run's status."""
    import yfinance as yf

    started = time.monotonic()
    beat = asyncio.create_task(_beat(engine, run_id))
    as_of = datetime.now(UTC).replace(microsecond=0)
    snapshots = volume / SNAPSHOTS_SUBDIR
    building = snapshots / f".building-{run_id}"
    try:
        cache = _fresh_cache(volume, time.time())
        counts = await asyncio.to_thread(
            build_snapshot,
            building,
            as_of=as_of,
            info_cache=cache / INFO_CACHE,
            holdings_cache=cache / HOLDINGS_CACHE,
            workers=workers,
            yfinance_version=yf.__version__,
        )
        built_seconds = round(time.monotonic() - started)

        with engine.begin() as connection:
            loaded = load_into_database(
                connection,
                building,
                descriptions=None,
                source=DESCRIPTION_SOURCE,
                license=DESCRIPTION_LICENSE,
            )
            embedded = await embed_pending(connection, embedder)
        # Published only now: the load committed, so the startup loader will
        # never meet a snapshot this service could not load itself.
        final = snapshots / _snapshot_name(as_of)
        building.rename(final)
        # Only now: a failure before this point leaves the cache for the next attempt.
        shutil.rmtree(volume / CACHE_SUBDIR, ignore_errors=True)
        report = loaded.report
        stats = {
            "snapshot": final.name,
            "as_of": loaded.as_of,
            "counts": counts,
            "created": report.created,
            "text_changed": report.text_changed,
            "unchanged": report.unchanged,
            "undescribed": report.undescribed,
            "dropped": loaded.dropped,
            "holdings_stored": loaded.holdings.total,
            "embedded": embedded,
            "build_seconds": built_seconds,
            "total_seconds": round(time.monotonic() - started),
        }
        finish(engine, run_id, "ok", stats)
        log.info("universe.rescreen_done", run_id=run_id, **stats)
        return "ok"
    except IncompleteFetch as error:
        # Kept: the cache. The next attempt asks only for what is missing.
        finish(engine, run_id, "failed", {"error": str(error), "missing": len(error.symbols)})
        log.warning("universe.rescreen_incomplete", run_id=run_id, missing=len(error.symbols))
        return "failed"
    except Exception as error:
        finish(engine, run_id, "failed", {"error": f"{type(error).__name__}: {error}"})
        log.exception("universe.rescreen_failed", run_id=run_id)
        return "failed"
    finally:
        beat.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await beat
        shutil.rmtree(building, ignore_errors=True)
