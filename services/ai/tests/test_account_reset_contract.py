"""The groups a reset may erase are one list, in the migration and in TypeScript.

The orchestrator validates a reset's groups against `ACCOUNT_RESET_GROUPS`, and
the database function refuses any group not in 0045's `RESET_GROUPS`. If the
two drift, a checkbox on the Admin page either fails every reset that ticks it
or is refused before it reaches the database - so they are read and compared.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATION = REPO_ROOT / "services" / "ai" / "alembic" / "versions" / "0045_account_reset.py"
SHARED_TYPES = REPO_ROOT / "packages" / "shared" / "src" / "types.ts"


def _migration_groups() -> tuple[str, ...]:
    spec = importlib.util.spec_from_file_location("migration_0045", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.RESET_GROUPS


def _typescript_groups() -> tuple[str, ...]:
    match = re.search(
        r"export const ACCOUNT_RESET_GROUPS = \[([^\]]*)\] as const;", SHARED_TYPES.read_text()
    )
    assert match, "ACCOUNT_RESET_GROUPS not found in packages/shared/src/types.ts"
    return tuple(re.findall(r"'([^']+)'", match.group(1)))


def test_the_migration_and_the_api_name_the_same_groups_in_the_same_order() -> None:
    assert _typescript_groups() == _migration_groups()
