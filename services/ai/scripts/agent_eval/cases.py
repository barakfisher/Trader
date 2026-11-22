"""The eval set's cases and worlds, read from `data/eval/agent_scans.json`.

A world is a dump of production by name; its clock is the stamp in that name, the
moment `db-backup.sh` took it. A case is one agent in one world. The file is the
source of truth (D424): what a run compared is this file at the run's commit.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_CASES = REPO_ROOT / "data" / "eval" / "agent_scans.json"
#: Where frozen worlds are kept: beside the backups and outside their rotation, which
#: keeps the newest fourteen dumps and would delete a world within weeks (D422).
DEFAULT_FROZEN_DIR = Path.home() / "Backups" / "traders" / "eval"

#: A dump's name as `db-backup.sh` writes it: the target, then a UTC stamp.
DUMP_NAME = re.compile(r"traders-(?P<target>[a-z]+)-(?P<stamp>\d{8}T\d{6}Z)")
STAMP_FORMAT = "%Y%m%dT%H%M%SZ"


class CaseFileError(ValueError):
    """The case file names something that cannot be run."""


@dataclass(frozen=True)
class World:
    """One frozen copy of production: the dump it is restored from, and its clock."""

    id: str
    dump: str

    @property
    def stamp(self) -> str:
        match = DUMP_NAME.fullmatch(self.dump)
        if match is None:
            raise CaseFileError(f"world {self.id!r}: {self.dump!r} is not a db-backup.sh dump name")
        return match["stamp"]

    @property
    def as_of(self) -> datetime:
        """The moment the dump was taken: the world's clock."""
        return datetime.strptime(self.stamp, STAMP_FORMAT).replace(tzinfo=UTC)

    @property
    def database(self) -> str:
        """The disposable database the world is restored into; a run clones it."""
        return f"frozen_{self.stamp.lower()}_ci"

    def dump_file(self, frozen_dir: Path) -> Path:
        return frozen_dir / f"{self.dump}.dump"

    def closes_file(self, frozen_dir: Path) -> Path:
        """The closes fetched when the world was frozen (`frozen_market.py`)."""
        return frozen_dir / f"{self.dump}.closes.json"


@dataclass(frozen=True)
class Case:
    id: str
    world: World
    agent: str


def parse_cases(raw: dict[str, Any]) -> list[Case]:
    """The cases of a parsed case file; raises `CaseFileError` on one that cannot run."""
    worlds = {
        world_id: World(id=world_id, dump=str(entry.get("dump", "")))
        for world_id, entry in raw.get("worlds", {}).items()
    }
    for world in worlds.values():
        _ = world.stamp  # a malformed name is refused here, not at the first restore
    cases: list[Case] = []
    seen: set[str] = set()
    for entry in raw.get("cases", []):
        case_id, world_id, agent = entry.get("id"), entry.get("world"), entry.get("agent")
        if not case_id or case_id in seen:
            raise CaseFileError(f"case id {case_id!r} is missing or used twice")
        if world_id not in worlds:
            raise CaseFileError(f"case {case_id!r} names world {world_id!r}, which is not listed")
        if not isinstance(agent, str) or not agent.strip():
            raise CaseFileError(f"case {case_id!r} names no agent")
        seen.add(case_id)
        cases.append(Case(id=case_id, world=worlds[world_id], agent=agent))
    if not cases:
        raise CaseFileError("the case file has no cases")
    return cases


def read_cases(path: Path = DEFAULT_CASES) -> list[Case]:
    return parse_cases(json.loads(path.read_text(encoding="utf-8")))


def missing_files(cases: list[Case], frozen_dir: Path) -> list[Path]:
    """Every file the cases need that is not there, in the order a run would meet them."""
    wanted: list[Path] = []
    for case in cases:
        for path in (case.world.dump_file(frozen_dir), case.world.closes_file(frozen_dir)):
            if path not in wanted:
                wanted.append(path)
    return [path for path in wanted if not path.is_file()]
