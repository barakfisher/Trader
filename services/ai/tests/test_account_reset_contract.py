"""The groups a reset may erase are one list, in the migration and in TypeScript.

The orchestrator validates a reset's groups against `ACCOUNT_RESET_GROUPS`, and
the database function refuses any group not in the latest migration's
`RESET_GROUPS` (0045 set it, 0082 removed `followed_topics`). If the
two drift, a checkbox on the Admin page either fails every reset that ticks it
or is refused before it reaches the database - so they are read and compared.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
VERSIONS = REPO_ROOT / "services" / "ai" / "alembic" / "versions"
SHARED_TYPES = REPO_ROOT / "packages" / "shared" / "src" / "types.ts"


def _migration_groups() -> tuple[str, ...]:
    """`RESET_GROUPS` of the newest migration that defines it: the function now in force."""
    groups: tuple[str, ...] = ()
    for path in sorted(VERSIONS.glob("[0-9][0-9][0-9][0-9]_*.py")):
        spec = importlib.util.spec_from_file_location(f"migration_{path.stem}", path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        groups = getattr(module, "RESET_GROUPS", groups)
    assert groups, "no migration defines RESET_GROUPS"
    return groups


def _typescript_groups() -> tuple[str, ...]:
    match = re.search(
        r"export const ACCOUNT_RESET_GROUPS = \[([^\]]*)\] as const;", SHARED_TYPES.read_text()
    )
    assert match, "ACCOUNT_RESET_GROUPS not found in packages/shared/src/types.ts"
    return tuple(re.findall(r"'([^']+)'", match.group(1)))


def test_the_migration_and_the_api_name_the_same_groups_in_the_same_order() -> None:
    assert _typescript_groups() == _migration_groups()
