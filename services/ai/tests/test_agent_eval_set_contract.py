"""The agent-scan eval set is a file a paid run trusts; this is what it must keep true.

Hermetic: the dumps the set names are not in the repository and are not read here.
"""

from __future__ import annotations

from datetime import UTC
from pathlib import Path

import pytest

from scripts.agent_eval.cases import (
    DEFAULT_CASES,
    DUMP_NAME,
    CaseFileError,
    World,
    missing_files,
    parse_cases,
    read_cases,
)
from scripts.agent_eval.frozen_world import (
    DISPOSABLE_SUFFIX,
    LOOPBACK_HOSTS,
    MAX_NAME_LENGTH,
    WorldError,
    database_url,
    disposable,
    local_server,
)
from scripts.run_agent_eval import clone_name

WORLD = {"dump": "traders-prod-20261119T072136Z"}


def _file(**overrides: object) -> dict[str, object]:
    return {
        "worlds": {"w": WORLD},
        "cases": [{"id": "a-w", "world": "w", "agent": "A"}],
        **overrides,
    }


def test_the_committed_set_parses_and_every_case_can_be_named_as_a_database() -> None:
    cases = read_cases(DEFAULT_CASES)
    assert cases
    assert len({case.id for case in cases}) == len(cases)
    for case in cases:
        assert DUMP_NAME.match(case.world.dump)
        # Both names are created and dropped by the run: each must pass its own guard.
        assert disposable(case.world.database) == case.world.database
        assert disposable(clone_name(case.id, 1)) == clone_name(case.id, 1)


def test_every_world_is_a_production_dump_with_two_samples_of_agents() -> None:
    cases = read_cases(DEFAULT_CASES)
    for world in {case.world for case in cases}:
        match = DUMP_NAME.match(world.dump)
        assert match is not None and match["target"] == "prod"
        # A world with one agent says nothing about a change that reaches every agent.
        assert len({case.agent for case in cases if case.world == world}) > 1


def test_a_world_keeps_the_clock_of_its_dump() -> None:
    world = World(id="w", dump=WORLD["dump"])
    assert world.as_of.tzinfo is UTC
    assert world.as_of.strftime("%Y%m%dT%H%M%SZ") == world.stamp
    assert world.stamp.lower() in world.database
    assert world.database.endswith(DISPOSABLE_SUFFIX)


@pytest.mark.parametrize(
    "broken",
    [
        _file(cases=[]),
        _file(cases=[{"id": "a", "world": "elsewhere", "agent": "A"}]),
        _file(cases=[{"id": "a", "world": "w", "agent": " "}]),
        _file(cases=[{"id": "a", "world": "w", "agent": "A"}] * 2),
        _file(worlds={"w": {"dump": "traders-prod-yesterday"}}),
    ],
)
def test_a_set_that_cannot_run_is_refused_when_read(broken: dict[str, object]) -> None:
    with pytest.raises(CaseFileError):
        parse_cases(broken)  # type: ignore[arg-type]


def test_missing_files_names_each_world_file_once(tmp_path: Path) -> None:
    cases = parse_cases(
        {
            "worlds": {"w": WORLD},
            "cases": [
                {"id": "a-w", "world": "w", "agent": "A"},
                {"id": "b-w", "world": "w", "agent": "B"},
            ],
        }
    )
    world = cases[0].world
    assert missing_files(cases, tmp_path) == [
        world.dump_file(tmp_path),
        world.closes_file(tmp_path),
    ]
    world.dump_file(tmp_path).write_bytes(b"")
    assert missing_files(cases, tmp_path) == [world.closes_file(tmp_path)]
    world.closes_file(tmp_path).write_text("{}", encoding="utf-8")
    assert missing_files(cases, tmp_path) == []


@pytest.mark.parametrize(
    "name",
    [
        "traders",
        "traders_ci; DROP",
        "Traders_ci",
        "",
        "frozen_ci\n",
        'frozen"_ci',
        "x" * (MAX_NAME_LENGTH - len(DISPOSABLE_SUFFIX) + 1) + DISPOSABLE_SUFFIX,
    ],
)
def test_only_a_plain_disposable_name_may_be_created_or_dropped(name: str) -> None:
    with pytest.raises(WorldError):
        disposable(name)


def test_the_longest_name_postgres_keeps_whole_is_allowed() -> None:
    name = "x" * (MAX_NAME_LENGTH - len(DISPOSABLE_SUFFIX)) + DISPOSABLE_SUFFIX
    assert disposable(name) == name


@pytest.mark.parametrize("host", LOOPBACK_HOSTS)
def test_a_server_on_this_machine_is_accepted(host: str) -> None:
    bracketed = f"[{host}]" if ":" in host else host
    assert local_server(f"postgresql://u:p@{bracketed}:55436").host == host


@pytest.mark.parametrize("host", ["db.example.com", "10.0.0.5", "traders-prod"])
def test_a_server_elsewhere_is_refused_before_anything_is_created(host: str) -> None:
    with pytest.raises(WorldError):
        local_server(f"postgresql://u:p@{host}:5432")
    with pytest.raises(WorldError):
        database_url(f"postgresql://u:p@{host}:5432", "frozen_ci")


def test_a_dump_name_with_anything_after_its_stamp_is_refused() -> None:
    with pytest.raises(CaseFileError):
        _ = World(id="w", dump=WORLD["dump"] + "\n").stamp
