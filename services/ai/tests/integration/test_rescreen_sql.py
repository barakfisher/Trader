"""The rescreen run through the real SQL, and a restart that must not undo it (decision 90).

Yahoo is the one thing replaced: `build_snapshot` writes the committed snapshot
minus one member, as a rescreen would after that listing fell below the floor.
Everything after the fetch is real - the rename into the volume, the load, the
member marked `dropped`, the embedding, the run row finished by the AI service
- and then the startup loader runs twice, with the volume and without it, and
must leave the rescreen's universe standing both times.
"""

from __future__ import annotations

import json
import shutil
import uuid
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.corpus.hashed_embedder import HashedEmbedder
from app.universe import rescreen
from app.universe.loading import SNAPSHOTS_SUBDIR
from app.universe.screener import IncompleteFetch
from app.universe.snapshot import (
    DESCRIPTIONS_FILE,
    ETF_HOLDINGS_FILE,
    MANIFEST_FILE,
    MEMBERSHIP_FILE,
)
from tests.integration.conftest import REPO_ROOT, run_script

FIXTURE_EMBEDDER = {"EMBEDDINGS_PROVIDER": "fixture"}
COMMITTED = REPO_ROOT / "data" / "universe"
FIXTURE_DESCRIPTIONS = REPO_ROOT / "data" / "fixtures" / "universe" / "descriptions.jsonl"
#: A fixture member with a description, so it has a profile to drop.
FALLEN = "NXE"
#: A fixture member the rescreen keeps but without a description: its earlier
#: profile stays, and the load must count it as kept rather than missing.
UNDESCRIBED = "UEC"


def _membership(engine: Engine, symbol: str) -> str | None:
    with engine.connect() as connection:
        return connection.execute(
            text(
                "SELECT p.membership FROM instrument_profiles p "
                "JOIN instruments i ON i.id = p.instrument_id WHERE i.symbol = :symbol"
            ),
            {"symbol": symbol},
        ).scalar_one_or_none()


def _claim(engine: Engine) -> str:
    run_id = str(uuid.uuid4())
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO runs (id, kind, run_key, trigger, status) "
                "VALUES (:id, 'universe_rescreen', :key, 'test', 'running')"
            ),
            {"id": run_id, "key": f"universe-rescreen:test-{run_id}"},
        )
    return run_id


def _run(engine: Engine, run_id: str) -> tuple[str, dict]:
    with engine.connect() as connection:
        row = connection.execute(
            text("SELECT status, stats, heartbeat_at FROM runs WHERE id = :id"), {"id": run_id}
        ).one()
    assert row.heartbeat_at is not None
    return row.status, row.stats


def fake_build(
    out: Path, *, as_of: datetime, info_cache: Path, holdings_cache: Path, **_: object
) -> dict[str, int]:
    """The committed snapshot without FALLEN, dated `as_of`, with the fixture descriptions."""
    info_cache.parent.mkdir(parents=True, exist_ok=True)
    info_cache.write_text("")
    out.mkdir(parents=True)
    members = [
        line
        for line in (COMMITTED / MEMBERSHIP_FILE).read_text().splitlines()
        if json.loads(line)["symbol"] != FALLEN
    ]
    (out / MEMBERSHIP_FILE).write_text("\n".join(members) + "\n")
    descriptions = [
        line
        for line in FIXTURE_DESCRIPTIONS.read_text().splitlines()
        if line and json.loads(line)["symbol"] not in (FALLEN, UNDESCRIBED)
    ]
    (out / DESCRIPTIONS_FILE).write_text("\n".join(descriptions) + "\n")
    shutil.copyfile(COMMITTED / ETF_HOLDINGS_FILE, out / ETF_HOLDINGS_FILE)
    manifest = {"as_of": as_of.isoformat().replace("+00:00", "Z"), "counts": {"kept": len(members)}}
    (out / MANIFEST_FILE).write_text(json.dumps(manifest))
    return {"kept": len(members)}


@pytest.fixture(scope="module")
def loaded(migrated: Engine, database_url: str) -> Engine:
    result = run_script(database_url, "scripts/ingest_universe.py", "--fixture", **FIXTURE_EMBEDDER)
    assert result.returncode == 0, result.stdout + result.stderr
    assert _membership(migrated, FALLEN) == "screened"
    return migrated


async def test_a_failed_fetch_finishes_the_run_and_keeps_the_cache(
    loaded: Engine, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refused(out: Path, *, info_cache: Path, **_: object) -> dict[str, int]:
        info_cache.parent.mkdir(parents=True, exist_ok=True)
        info_cache.write_text('{"symbol": "AAA", "info": {}}\n')
        raise IncompleteFetch("symbols", ["BBB"])

    monkeypatch.setattr(rescreen, "build_snapshot", refused)
    run_id = _claim(loaded)
    status = await rescreen.run_rescreen(
        run_id, volume=tmp_path, engine=loaded, embedder=HashedEmbedder()
    )
    assert status == "failed"
    run_status, stats = _run(loaded, run_id)
    assert (run_status, stats["missing"]) == ("failed", 1)
    # The next attempt resumes from here; nothing half-built is left visible.
    assert (tmp_path / rescreen.CACHE_SUBDIR / "info.jsonl").exists()
    assert list((tmp_path / SNAPSHOTS_SUBDIR).glob("*")) == []
    assert _membership(loaded, FALLEN) == "screened"


async def test_a_failed_load_publishes_nothing(
    loaded: Engine, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken_load(*args: object, **kwargs: object) -> None:
        raise RuntimeError("a row the database refused")

    monkeypatch.setattr(rescreen, "build_snapshot", fake_build)
    monkeypatch.setattr(rescreen, "load_into_database", broken_load)
    run_id = _claim(loaded)
    status = await rescreen.run_rescreen(
        run_id, volume=tmp_path, engine=loaded, embedder=HashedEmbedder()
    )
    assert status == "failed"
    # The startup loader takes the newest snapshot it finds: one this run could
    # not load must not be there for it to find.
    assert list((tmp_path / SNAPSHOTS_SUBDIR).iterdir()) == []
    assert (tmp_path / rescreen.CACHE_SUBDIR).exists()
    assert _membership(loaded, FALLEN) == "screened"


async def test_a_rescreen_loads_drops_and_survives_a_restart(
    loaded: Engine, database_url: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(rescreen, "build_snapshot", fake_build)
    run_id = _claim(loaded)
    status = await rescreen.run_rescreen(
        run_id, volume=tmp_path, engine=loaded, embedder=HashedEmbedder()
    )
    assert status == "ok"
    run_status, stats = _run(loaded, run_id)
    assert run_status == "ok"
    assert stats["dropped"] == 1
    snapshots = list((tmp_path / SNAPSHOTS_SUBDIR).iterdir())
    assert [path.name for path in snapshots] == [stats["snapshot"]]
    assert not (tmp_path / rescreen.CACHE_SUBDIR).exists()
    assert _membership(loaded, FALLEN) == "dropped"
    assert _membership(loaded, UNDESCRIBED) == "screened"
    with loaded.connect() as connection:
        report = connection.execute(
            text("SELECT report FROM universe_loads ORDER BY id DESC LIMIT 1")
        ).scalar_one()
    assert report["undescribed_kept"] == 1

    # A restart with the volume: the rescreen's snapshot is the newest.
    with_volume = run_script(
        database_url,
        "scripts/ingest_universe.py",
        "--fixture",
        UNIVERSE_SNAPSHOT_DIR=str(tmp_path),
        **FIXTURE_EMBEDDER,
    )
    assert with_volume.returncode == 0, with_volume.stdout + with_volume.stderr
    assert stats["snapshot"] in with_volume.stdout
    assert _membership(loaded, FALLEN) == "dropped"

    # A restart that lost the volume: the image's older snapshot is refused.
    without = run_script(
        database_url, "scripts/ingest_universe.py", "--fixture", **FIXTURE_EMBEDDER
    )
    assert without.returncode == 0, without.stdout + without.stderr
    assert "would undo a rescreen" in without.stdout
    assert _membership(loaded, FALLEN) == "dropped"


def test_one_running_rescreen_at_a_time(loaded: Engine) -> None:
    run_id = _claim(loaded)
    try:
        with pytest.raises(Exception, match="runs_one_running_rescreen"):
            _claim(loaded)
    finally:
        # Left running, it would refuse every later claim on this database.
        rescreen.finish(loaded, run_id, "ok", {})
