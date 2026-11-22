"""A frozen world as databases: one restored from the dump, and one clone of it per scan.

**Why a clone per scan.** A scan writes: its own row, which the next scan would be
told about as memory (D354), and its model calls, which the agent's daily allowance
counts. Three samples of one case on one database would be three different cases.
So the dump is restored once per run into `World.database`, brought to this
checkout's schema, and every scan runs on `CREATE DATABASE ... TEMPLATE` of it,
dropped afterwards. Postgres copies the files; nothing is replayed.

**Restored again on every run**, not kept: the template is migrated to the head of
the code that runs it, and a run on `main` after a run on a branch with a newer
migration would otherwise meet a schema ahead of its code (D425).

**Only disposable names, only this machine.** Every database made, migrated or
dropped here ends in `_ci`, and the server must be a loopback address: the eval's
own container (`scripts/eval-world.sh`), never production's. A mistaken
`--server-url` that names compose's server can still reach it, and there only a
`_ci` name.

**Only the installation's own agents.** A dump holds every user's rows. A case's
agent is looked up among the admin's (`find_agent_id`), so a run never sends a
model another user's portfolio because their agent shares a name.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.engine.url import URL, make_url
from sqlalchemy.pool import NullPool

from app.agents.scan_memory import DECIDED_OUTCOMES, RECENT_SCANS
from scripts.agent_eval.cases import REPO_ROOT, World

SERVICE_DIR = Path(__file__).resolve().parents[2]
EVAL_WORLD_SCRIPT = REPO_ROOT / "scripts" / "eval-world.sh"
#: The eval's own Postgres, started by `scripts/eval-world.sh`. Local, disposable, and
#: its password is the script's: nothing here is a secret of the installation.
DEFAULT_SERVER_URL = "postgresql://traders:traders@127.0.0.1:55436"
DISPOSABLE_SUFFIX = "_ci"
#: Postgres cuts a longer identifier silently, and two cut names can be one database.
MAX_NAME_LENGTH = 63
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
#: Whose agents a case may name: the installation's own account (`users.role`).
OWNER_ROLE = "admin"
_NAME = re.compile(r"[a-z0-9_]+")


class WorldError(RuntimeError):
    """A world could not be made ready; the message says what to do."""


def disposable(name: str) -> str:
    """The database name, if this module may create and drop it; raises otherwise."""
    if (
        not _NAME.fullmatch(name)
        or not name.endswith(DISPOSABLE_SUFFIX)
        or len(name) > MAX_NAME_LENGTH
    ):
        raise WorldError(
            f"the eval creates and drops its databases; {name!r} is not a plain name of at"
            f" most {MAX_NAME_LENGTH} characters ending in {DISPOSABLE_SUFFIX!r}"
        )
    return name


def local_server(server_url: str) -> URL:
    """The server's URL, if it is on this machine; raises otherwise."""
    url = make_url(server_url)
    if url.host not in LOOPBACK_HOSTS:
        raise WorldError(
            f"the eval writes only to a Postgres on this machine; {url.host!r} is not one of"
            f" {LOOPBACK_HOSTS}"
        )
    return url


def database_url(server_url: str, name: str) -> URL:
    return local_server(server_url).set(drivername="postgresql+psycopg", database=disposable(name))


def plain_url(url: URL) -> str:
    """The URL as the service's own scripts take it (`DATABASE_URL`)."""
    return url.set(drivername="postgresql").render_as_string(hide_password=False)


def connect(server_url: str, name: str) -> Engine:
    """An engine on one of the eval's databases. Unpooled: a database that still has
    a connection can be neither cloned nor dropped."""
    return create_engine(database_url(server_url, name), future=True, poolclass=NullPool)


def _admin(server_url: str) -> Engine:
    url = local_server(server_url).set(drivername="postgresql+psycopg", database="postgres")
    return create_engine(url, future=True, poolclass=NullPool, isolation_level="AUTOCOMMIT")


def _eval_world(frozen_dir: Path, *args: str) -> None:
    result = subprocess.run(
        ["bash", str(EVAL_WORLD_SCRIPT), *args],
        env={**os.environ, "TRADERS_EVAL_DIR": str(frozen_dir)},
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise WorldError(f"eval-world.sh {' '.join(args)} failed:\n{result.stdout}{result.stderr}")


def keep(world: World, frozen_dir: Path) -> None:
    """Copy the world's dump out of the backups' rotation, if it is not kept already."""
    _eval_world(frozen_dir, "keep", world.dump)


def restore(world: World, frozen_dir: Path) -> None:
    """Restore the world's dump into `world.database`, replacing an earlier copy."""
    _eval_world(frozen_dir, "restore", world.dump, disposable(world.database))


def migrate(server_url: str, name: str) -> None:
    """Bring a restored world to this checkout's schema, as a deployment would."""
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=SERVICE_DIR,
        env={
            **os.environ,
            "DATABASE_URL": plain_url(database_url(server_url, name)),
            "PYTHONPATH": str(SERVICE_DIR),
        },
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise WorldError(f"migrating {name} failed:\n{result.stdout}\n{result.stderr}")


def prepare(world: World, frozen_dir: Path, server_url: str) -> None:
    restore(world, frozen_dir)
    migrate(server_url, world.database)


@contextmanager
def clone(world: World, server_url: str, name: str) -> Iterator[Engine]:
    """A copy of the prepared world for one scan, dropped when the block ends."""
    name, template = disposable(name), disposable(world.database)
    admin = _admin(server_url)
    with admin.connect() as connection:
        connection.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        connection.execute(text(f'CREATE DATABASE "{name}" TEMPLATE "{template}"'))
    engine = connect(server_url, name)
    try:
        yield engine
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()


def find_agent_id(engine: Engine, name: str) -> tuple[str, str]:
    """The (user id, agent id) of the admin's one simulated agent of that name; raises
    if the world has none. Another user's agent is never matched, whatever its name."""
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                SELECT a.user_id::text, a.id::text
                  FROM agents a
                  JOIN users u ON u.id = a.user_id AND u.role = :role
                 WHERE a.name = :name AND NOT a.is_primary
                """
            ),
            {"name": name, "role": OWNER_ROLE},
        ).all()
    if len(rows) != 1:
        raise WorldError(
            f"{len(rows)} of the {OWNER_ROLE}'s agents are named {name!r} in this world;"
            " a case needs one"
        )
    return rows[0][0], rows[0][1]


def earlier_theses(engine: Engine, agent_id: str) -> list[str]:
    """The reasons of the agent's last decided scans, as the readings compare them:
    the same scans the agent is shown as memory (`scan_memory.recent_scans`)."""
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                SELECT concat_ws(E'\n', s.answer ->> 'thesis',
                                 (SELECT string_agg(t ->> 'thesis', E'\n')
                                    FROM jsonb_array_elements(s.answer -> 'trades') t))
                  FROM agent_scans s
                 WHERE s.agent_id = CAST(:agent AS uuid) AND s.finished_at IS NOT NULL
                   AND s.outcome = ANY(:outcomes)
                 ORDER BY s.started_at DESC
                 LIMIT :limit
                """
            ),
            {"agent": agent_id, "outcomes": list(DECIDED_OUTCOMES), "limit": RECENT_SCANS},
        ).scalars()
        return [row for row in rows if row]
