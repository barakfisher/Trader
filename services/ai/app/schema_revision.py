"""Is the database's schema the one this code was written for?

Kubernetes has no `depends_on`. In docker compose the loaders and the services
wait for the `migrate` container to exit successfully; in a cluster every pod
starts as soon as it is scheduled, and a pod restarted days later starts with no
memory of the migration Job at all. So instead of trusting an order, each pod
that needs the schema checks it: an init container runs
`scripts/wait_for_schema.py`, which asks this module whether the database is at
the revision this image's migrations end in, and waits until it is.

"At head" means exactly this image's head(s). A database *behind* them is the
ordinary case during a deploy - the migration Job has not finished yet. A
database *ahead* of them (a revision this image does not know) means an older
image is starting against a newer schema; waiting will not fix that, but it is
reported with both revisions named rather than surfacing later as a SQL error.
"""

from __future__ import annotations

from pathlib import Path

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy.engine import Connection

SERVICE_ROOT = Path(__file__).resolve().parents[1]


def expected_heads() -> frozenset[str]:
    """The head revision(s) of the migrations shipped with this code."""
    config = Config(str(SERVICE_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
    return frozenset(ScriptDirectory.from_config(config).get_heads())


def current_heads(connection: Connection) -> frozenset[str]:
    """The revision(s) recorded in the database; empty before the first migration."""
    return frozenset(MigrationContext.configure(connection).get_current_heads())


def is_current(current: frozenset[str], expected: frozenset[str]) -> bool:
    return bool(expected) and current == expected


def describe(current: frozenset[str], expected: frozenset[str]) -> str:
    """One line for the pod log: what the database has and what the code wants."""
    have = ", ".join(sorted(current)) or "no revision (never migrated)"
    want = ", ".join(sorted(expected))
    unknown = current - expected
    if unknown and not is_current(current, expected):
        return f"database is at {have}, which this image does not know (it expects {want})"
    return f"database is at {have}; this image expects {want}"
