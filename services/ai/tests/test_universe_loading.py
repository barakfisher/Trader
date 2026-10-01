"""Which snapshot the loader loads, and a fetch that resumes rather than restarts.

The rule is what decides whether a rescreen survives a restart (decision 90):
the newest snapshot wins wherever it is, and nothing older than the last load
is ever loaded over the database. The fetch cache is what makes a rescreen
killed half-way resumable - and it must never record a failure as an answer.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.universe import screener
from app.universe.loading import (
    SNAPSHOTS_SUBDIR,
    choose_snapshot,
    newest_snapshot,
    volume_snapshots,
)
from app.universe.screener import IncompleteFetch, fetch_infos
from app.universe.snapshot import MANIFEST_FILE

IMAGE_AS_OF = "2026-09-24T12:04:35Z"
RESCREEN_AS_OF = "2026-10-01T00:12:07Z"


def _snapshot(directory: Path, as_of: str) -> Path:
    directory.mkdir(parents=True)
    (directory / MANIFEST_FILE).write_text(json.dumps({"as_of": as_of}))
    return directory


def _at(as_of: str) -> datetime:
    return datetime.fromisoformat(as_of.replace("Z", "+00:00"))


class TestChoice:
    def test_the_newest_wins_wherever_it_is(self, tmp_path: Path) -> None:
        image = _snapshot(tmp_path / "image", IMAGE_AS_OF)
        rescreened = _snapshot(tmp_path / "volume" / "2026-10-01", RESCREEN_AS_OF)
        assert newest_snapshot([image, rescreened]) == rescreened
        assert choose_snapshot([image, rescreened], _at(IMAGE_AS_OF)).directory == rescreened

    def test_never_loads_an_older_snapshot_over_a_newer_load(self, tmp_path: Path) -> None:
        # The volume was lost: only the image's snapshot is left, and the
        # database already holds a rescreen's.
        image = _snapshot(tmp_path / "image", IMAGE_AS_OF)
        choice = choose_snapshot([image], _at(RESCREEN_AS_OF))
        assert choice.directory is None
        assert "would undo a rescreen" in choice.reason

    def test_reloads_the_same_snapshot(self, tmp_path: Path) -> None:
        # Every stack start reloads it: free, and how new descriptions arrive.
        image = _snapshot(tmp_path / "image", IMAGE_AS_OF)
        assert choose_snapshot([image], _at(IMAGE_AS_OF)).directory == image

    def test_a_fresh_database_loads_whatever_there_is(self, tmp_path: Path) -> None:
        image = _snapshot(tmp_path / "image", IMAGE_AS_OF)
        assert choose_snapshot([image], None).directory == image
        assert choose_snapshot([tmp_path / "missing"], None).directory is None

    def test_only_complete_snapshots_count_in_the_volume(self, tmp_path: Path) -> None:
        root = tmp_path / SNAPSHOTS_SUBDIR
        complete = _snapshot(root / "2026-10-01T00-12-07Z", RESCREEN_AS_OF)
        _snapshot(root / ".building-run", "2026-12-31T00:00:00Z")  # still being written
        (root / "2026-11-01T00-00-00Z").mkdir()  # never finished: no manifest
        assert volume_snapshots(tmp_path) == [complete]
        assert volume_snapshots(None) == []
        assert volume_snapshots(tmp_path / "nowhere") == []


class TestResumableFetch:
    def test_keeps_answers_and_raises_on_failures_then_resumes(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        cache = tmp_path / "info.jsonl"
        refused = {"BBB"}
        asked: list[str] = []

        def fetch(symbol: str) -> dict | None:
            asked.append(symbol)
            if symbol in refused:
                return None
            return {"longBusinessSummary": f"{symbol} does things.", "noise": "dropped"}

        monkeypatch.setattr(screener, "_fetch_info", fetch)
        with pytest.raises(IncompleteFetch) as failed:
            fetch_infos(["AAA", "BBB", "CCC"], cache, workers=2)
        assert failed.value.symbols == ["BBB"]
        # A failure is not an answer: only AAA and CCC were written down.
        cached = [json.loads(line)["symbol"] for line in cache.read_text().splitlines()]
        assert sorted(cached) == ["AAA", "CCC"]

        refused.clear()
        asked.clear()
        infos = fetch_infos(["AAA", "BBB", "CCC"], cache, workers=2)
        assert asked == ["BBB"]
        assert infos["BBB"] == {"longBusinessSummary": "BBB does things."}
        assert set(infos) == {"AAA", "BBB", "CCC"}

    def test_an_empty_payload_is_an_answer(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(screener, "_fetch_info", lambda symbol: {})
        assert fetch_infos(["NODESC"], tmp_path / "info.jsonl", workers=1) == {"NODESC": {}}


def test_snapshot_names_sort_by_time() -> None:
    from app.universe.rescreen import _snapshot_name

    earlier = _snapshot_name(datetime(2026, 9, 30, 23, 59, 59, tzinfo=UTC))
    later = _snapshot_name(datetime(2026, 10, 1, 0, 0, 0, tzinfo=UTC))
    assert earlier < later
    assert ":" not in later
