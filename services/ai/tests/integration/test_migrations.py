"""Every migration, down to base and back up, over rows that exercise its CHECKs.

CI's other jobs migrate an *empty* database, which proves the SQL parses and
nothing else. Both migration bugs that cost real time were invisible there:
0006 retyped `runs_kind_check` and dropped a value, so every database holding a
backfill run refused it; 0021's downgrade relabelled rows while the CHECK it was
about to drop still stood. A constraint is exercised only by data.

So: upgrade an empty database to head, load `seed_head.sql`, and walk down one
revision at a time to base. **Each step is a round trip over data**: down one,
back up over whatever rows that downgrade left, and down again. Walking down
alone tests only downgrades, and 0006's fault was in an *upgrade* meeting a
`backfill` row that 0005 had legitimately written. The seed must contain every
value any CHECK enumerates at head - checked here from `pg_constraint`, so a
migration that adds a value cannot pass until a row carries it down the chain.
"""

from __future__ import annotations

import re
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.engine import Engine

from tests.integration.conftest import SERVICE_DIR, alembic, current_revision, reset_schema

SEED = Path(__file__).with_name("seed_head.sql")

#: Downgrades that refuse, on purpose, to discard data - and what an operator
#: would do to proceed. A refusal not listed here is a failure; one listed here
#: that stops happening fails too, so the list cannot go stale.
KNOWN_REFUSALS: dict[str, tuple[str, str]] = {
    # Revoked intents are the audit of an undo. 0013's schema has nowhere to
    # keep them, so 0014 refuses rather than drop them silently.
    "0014_intent_revocation": (
        "intents holds revoked rows; downgrading would discard them",
        "DELETE FROM intents WHERE revoked_at IS NOT NULL",
    ),
    # The admin audit cannot be deleted while its triggers stand, so clearing
    # it takes the deliberate DDL act the error names (decision 84).
    "0026_admin_audit": (
        "admin_audit holds rows; downgrading would discard the audit",
        "ALTER TABLE admin_audit DISABLE TRIGGER USER; DELETE FROM admin_audit",
    ),
    # Removing `agent_id` would fold a simulated agent's rows into the real
    # portfolio, so 0036 refuses while one exists.
    "0036_agents": (
        "agents holds non-primary agents",
        "DELETE FROM agents WHERE NOT is_primary",
    ),
    # Fills and top-ups are the ledger's history (D23); opening deposits are
    # re-derived from budgets, so only the other two block the downgrade.
    "0040_ledger": (
        "the ledger holds fills or top-ups",
        "ALTER TABLE cash_movements DISABLE TRIGGER USER; ALTER TABLE fills DISABLE TRIGGER USER; "
        "DELETE FROM cash_movements WHERE kind <> 'opening_deposit'; DELETE FROM fills",
    ),
    # 0041's `agent` column names only narration and ask; a scan's call has no value there.
    "0042_agent_scan_inputs": (
        "llm_calls holds agent_scan calls",
        "DELETE FROM llm_calls WHERE purpose = 'agent_scan'",
    ),
}

#: `col = ANY (ARRAY['a'::text, 'b'::text])` as `pg_get_constraintdef` prints it.
_ENUMERATION = re.compile(r"\(?(\w+)\)? = ANY \(ARRAY\[([^\]]*)\]")
_VALUE = re.compile(r"'([^']*)'")


def _enumerated_values(engine: Engine) -> set[tuple[str, str, str]]:
    """(table, column, value) for every value a table CHECK enumerates."""
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                SELECT conrelid::regclass::text AS table_name,
                       pg_get_constraintdef(oid) AS definition
                  FROM pg_constraint
                 WHERE contype = 'c' AND conrelid <> 0
                """
            )
        ).all()
    found: set[tuple[str, str, str]] = set()
    for row in rows:
        for column, values in _ENUMERATION.findall(row.definition):
            found |= {(row.table_name, column, value) for value in _VALUE.findall(values)}
    return found


def _load_seed(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.exec_driver_sql(SEED.read_text())


def test_the_seed_covers_every_enumerated_value(migrated: Engine) -> None:
    _load_seed(migrated)
    enumerated = _enumerated_values(migrated)
    assert len(enumerated) > 50, "the constraint parser found almost nothing - check the regex"

    missing = []
    with migrated.connect() as connection:
        for table, column, value in sorted(enumerated):
            present = connection.execute(
                text(f'SELECT EXISTS (SELECT 1 FROM "{table}" WHERE "{column}" = :value)'),
                {"value": value},
            ).scalar()
            if not present:
                missing.append(f"{table}.{column} = {value!r}")
    assert not missing, (
        "seed_head.sql has no row for these enumerated values, so no downgrade is tested "
        "against them: " + ", ".join(missing)
    )


def test_every_migration_steps_down_to_base_over_data_and_back(
    engine: Engine, database_url: str
) -> None:
    reset_schema(engine)
    result = alembic(database_url, "upgrade", "head")
    assert result.returncode == 0, result.stderr
    head = current_revision(engine)
    _load_seed(engine)

    visited: list[str] = []
    refused: set[str] = set()
    while (revision := current_revision(engine)) is not None:
        step = alembic(database_url, "downgrade", "-1")
        if step.returncode != 0 and revision not in refused:
            known = KNOWN_REFUSALS.get(revision)
            assert known is not None and known[0] in step.stderr, (
                f"downgrade from {revision} failed over seeded rows:\n{step.stderr[-2000:]}"
            )
            refused.add(revision)
            with engine.begin() as connection:
                connection.execute(text(known[1]))
            step = alembic(database_url, "downgrade", "-1")
            assert step.returncode == 0, (
                f"downgrade from {revision} still failed after its refusal was cleared:\n"
                f"{step.stderr[-2000:]}"
            )
        assert step.returncode == 0, f"downgrade from {revision} failed:\n{step.stderr[-2000:]}"

        # Back up over the rows the downgrade left - the older schema's own data.
        again = alembic(database_url, "upgrade", "+1")
        assert again.returncode == 0, (
            f"upgrading to {revision} failed over rows the previous revision holds:\n"
            f"{again.stderr[-2000:]}"
        )
        assert current_revision(engine) == revision
        down = alembic(database_url, "downgrade", "-1")
        assert down.returncode == 0, (
            f"downgrade from {revision} failed on its second pass:\n{down.stderr[-2000:]}"
        )
        visited.append(revision)
        assert len(visited) <= 200, "the downgrade loop is not converging"

    migrations = len(list((SERVICE_DIR / "alembic" / "versions").glob("[0-9]*.py")))
    assert len(visited) == migrations, f"walked {len(visited)} of {migrations} revisions"
    assert refused == set(KNOWN_REFUSALS), (
        f"refusals listed but never raised: {sorted(set(KNOWN_REFUSALS) - refused)} - "
        "remove them from KNOWN_REFUSALS if the downgrade no longer refuses"
    )

    result = alembic(database_url, "upgrade", "head")
    assert result.returncode == 0, result.stderr
    assert current_revision(engine) == head
