"""The migration graph must have exactly one head, and every revision must be reachable.

This file exists because a migration number is a shared resource and nothing
enforced it. Two M4 PRs in flight both took `0007` off `0006`; that one was
caught by hand. The M3 corpus branch was not so lucky - it sat parked carrying
`0010_kb_corpus` off `0009_telegram_bindings` while `0010_instrument_metadata`
had taken the same parent on `main`, so merging it would have given Alembic two
heads and made `upgrade head` fail outright for everyone.

MEMORY.md's remedy was an instruction to a human: "check `alembic heads` returns
exactly one before merging anything with a migration." An instruction is only
followed by the sessions that read it, and the branch that needed it was written
before the instruction existed. This is that check as a gate.

The properties are about the *shape* of the graph, not about any particular
revision, so adding a migration means adding a file rather than editing a test.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

REPO_ROOT = Path(__file__).resolve().parents[3]
VERSIONS = REPO_ROOT / "services" / "ai" / "alembic" / "versions"


def _load(path: Path) -> ModuleType:
    """Import a migration by path. They are plain modules; Alembic just runs them."""
    spec = importlib.util.spec_from_file_location(f"migration_{path.stem}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _migrations() -> list[ModuleType]:
    modules = [_load(p) for p in sorted(VERSIONS.glob("[0-9]*.py"))]
    assert modules, f"no migrations found under {VERSIONS}"
    return modules


def test_exactly_one_head() -> None:
    """No revision may share a parent with another: that is what two heads means.

    Asserted as "every down_revision is claimed at most once" rather than by
    running Alembic, so the failure names the colliding pair directly instead of
    reporting that `upgrade head` is ambiguous.
    """
    modules = _migrations()
    parents: dict[str | None, list[str]] = {}
    for module in modules:
        parents.setdefault(module.down_revision, []).append(module.revision)

    collisions = {parent: kids for parent, kids in parents.items() if len(kids) > 1}
    assert not collisions, (
        "two or more migrations claim the same parent, which gives Alembic "
        f"multiple heads and breaks `upgrade head`: {collisions}. "
        "Renumber whichever branch is cheaper to move."
    )

    heads = {m.revision for m in modules} - {
        m.down_revision for m in modules if m.down_revision is not None
    }
    assert len(heads) == 1, f"expected exactly one head, found {sorted(heads)}"


def test_every_revision_is_unique() -> None:
    """A duplicated revision id makes one of the two files unreachable."""
    revisions = [m.revision for m in _migrations()]
    duplicates = {r for r in revisions if revisions.count(r) > 1}
    assert not duplicates, f"duplicate revision ids: {sorted(duplicates)}"


def test_chain_reaches_every_migration_from_a_single_base() -> None:
    """Walking back from the head must visit every file and end at exactly one base."""
    modules = _migrations()
    by_revision = {m.revision: m for m in modules}

    bases = [m.revision for m in modules if m.down_revision is None]
    assert len(bases) == 1, f"expected exactly one base revision, found {sorted(bases)}"

    heads = {m.revision for m in modules} - {
        m.down_revision for m in modules if m.down_revision is not None
    }
    assert len(heads) == 1, (
        f"expected exactly one head to walk back from, found {sorted(heads)}; "
        "test_exactly_one_head explains which migrations collided"
    )
    (head,) = heads

    visited: list[str] = []
    cursor: str | None = head
    while cursor is not None:
        assert cursor in by_revision, f"revision {cursor!r} is referenced but has no file"
        assert cursor not in visited, f"cycle in the migration graph at {cursor!r}"
        visited.append(cursor)
        cursor = by_revision[cursor].down_revision

    orphans = set(by_revision) - set(visited)
    assert not orphans, (
        f"these migrations are not reachable from the head {head!r}: {sorted(orphans)}"
    )


def test_filename_prefix_matches_revision_order() -> None:
    """The numeric prefix must sort in the same order the chain runs.

    The prefix is what a human reads when deciding which number is free. If it
    disagrees with the actual parent links, the next author picks the wrong one -
    which is precisely how this branch ended up carrying a duplicate `0010`.
    """
    modules = _migrations()
    by_revision = {m.revision: m for m in modules}

    for module in modules:
        if module.down_revision is None:
            continue
        parent = by_revision[module.down_revision]
        child_prefix = module.revision.split("_", 1)[0]
        parent_prefix = parent.revision.split("_", 1)[0]
        assert child_prefix > parent_prefix, (
            f"{module.revision} is numbered at or below its parent {parent.revision}; "
            "the filename order no longer reflects the chain order"
        )
