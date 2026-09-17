"""The run kinds the database accepts must be the ones the API can send.

This file exists because they disagreed, in the expensive direction. Migration
0006 rewrote `runs_kind_check` by retyping the list and dropped `backfill`,
which migration 0005 had been written specifically to add. The orchestrator went
on accepting `POST /internal/runs {"kind": "backfill"}` and writing the row, so
every database that had ever backfilled prices refused 0006 and stopped at
0005 - and with it the entire M4 schema.

Nothing caught it. The unit suites do not touch a database, and CI's migration
run starts from an empty one: **a CHECK constraint is only exercised by data**,
so an empty database proves the SQL parses and nothing more.

The two properties asserted here are the ones that would have caught it, and
they are deliberately about the *contract* rather than about any particular
kind, so adding a real kind means extending a tuple rather than editing a test.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from types import ModuleType

REPO_ROOT = Path(__file__).resolve().parents[3]
VERSIONS = REPO_ROOT / "services" / "ai" / "alembic" / "versions"
INTERNAL_ROUTE = REPO_ROOT / "apps" / "orchestrator" / "src" / "http" / "routes" / "internal.ts"


def _load(path: Path) -> ModuleType:
    """Import a migration by path. They are plain modules; Alembic just runs them."""
    spec = importlib.util.spec_from_file_location(f"migration_{path.stem}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _kind_migrations() -> list[ModuleType]:
    """Every migration that redefines `runs_kind_check`, oldest first.

    Discovered rather than named. A hardcoded "latest" would have to be edited by
    each new kind, and the point of this file is that adding a kind means
    extending a tuple and nothing else - a test somebody has to remember to
    update is the same hazard as a list somebody has to remember to retype.
    """
    modules = [_load(path) for path in sorted(VERSIONS.glob("[0-9][0-9][0-9][0-9]_*.py"))]
    return [module for module in modules if hasattr(module, "KINDS")]


def _kinds_accepted_by_the_api() -> set[str]:
    """The zod enum on `POST /internal/runs`, read from the source.

    Read rather than duplicated: a copy of the list in this file would be a
    third hand-written copy of exactly the thing that already went wrong twice.
    """
    source = INTERNAL_ROUTE.read_text(encoding="utf-8")
    match = re.search(r"kind:\s*z\.enum\(\[(.*?)\]\)", source, re.DOTALL)
    assert match is not None, "could not find the run-kind enum in internal.ts"
    return set(re.findall(r"'([a-z_]+)'", match.group(1)))


def test_the_database_accepts_every_kind_the_api_can_send() -> None:
    """The failure that stopped four migrations from ever applying.

    A kind the API writes and the constraint rejects is not a validation error:
    the row is written first and the constraint is met later, at upgrade time,
    on somebody else's machine.
    """
    latest = _kind_migrations()[-1]
    assert _kinds_accepted_by_the_api() <= set(latest.KINDS)


def test_no_migration_drops_a_run_kind() -> None:
    """A kind, once added, stays added.

    Kinds are only ever appended - a run of a retired kind is still a historical
    fact, and a constraint that stops describing it makes the row unupgradable
    rather than untrue. This is the property that the retyped literal broke, and
    it is stated here so the next migration to touch the constraint inherits it.
    """
    migrations = _kind_migrations()
    assert len(migrations) >= 2, "expected at least two migrations touching the constraint"
    for earlier, later in zip(migrations, migrations[1:], strict=False):
        assert set(earlier.KINDS) <= set(later.KINDS)
        # And the downgrade restores what was there, rather than a remembered list.
        assert set(earlier.KINDS) == set(later.PREVIOUS_KINDS)
