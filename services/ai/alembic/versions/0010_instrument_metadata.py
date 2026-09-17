"""Allow 'instrument_metadata' as a run kind.

Instruments created before the Yahoo provider learned to read a display name
have `name IS NULL` forever: `upsertInstrument` only fills a null name, and the
only thing that calls it is a holding write or an import, so a row nobody
touches again stays blank. In the local database that was 20 of 30 rows, which
in the holdings table and on the targets page reads as an inconsistency rather
than as missing data.

This run is the repair: it re-resolves instruments whose name is null and fills
in whatever the provider now returns. It is a run rather than a one-off script
because the gap is not one-off - any symbol Yahoo cannot name today may be
nameable next month, and `POST /internal/runs` is the one entry point scheduled
work has.

The constraint is extended the way 0006 was amended to extend it: `KINDS` is the
previous migration's tuple plus this one's addition, never a retyped literal,
and one helper builds the SQL so the constraint can only say what the tuple
says. `test_run_kinds_contract.py` holds both properties.

The revision id is short on purpose. `alembic_version.version_num` is
`varchar(32)`, and the first name for this one ('..._run_kind', 33 characters)
applied its DDL and then failed on the stamp - leaving the migration's work
rolled back and the chain still pointing at 0009. Nothing warns about this: the
limit is in a table Alembic created, not in anything that reads these files.

Revision ID: 0010_instrument_metadata
Revises: 0009_telegram_bindings
"""

from alembic import op

revision = "0010_instrument_metadata"
down_revision = "0009_telegram_bindings"
branch_labels = None
depends_on = None

#: The run kinds 0006 left behind. Named so this migration's downgrade restores
#: what was actually there, rather than a list somebody retyped from memory.
PREVIOUS_KINDS = (
    "snapshot",
    "portfolio_scan",
    "topic_scan",
    "daily_digest",
    "backfill",
    "proposal_sweep",
)

#: Kinds after this migration: the previous set plus the metadata backfill.
#: Adding a kind means extending this tuple, never rewriting the literal.
KINDS = (*PREVIOUS_KINDS, "instrument_metadata")


def _replace_run_kind_check(kinds: tuple[str, ...]) -> None:
    """Point `runs_kind_check` at exactly `kinds`."""
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check")
    op.execute(
        f"ALTER TABLE runs ADD CONSTRAINT runs_kind_check "
        f"CHECK (kind IN ({', '.join(repr(kind) for kind in kinds)}))"
    )


def upgrade() -> None:
    _replace_run_kind_check(KINDS)


def downgrade() -> None:
    # Drop the metadata rows before narrowing the constraint back, or the ALTER
    # fails on data the older schema cannot describe. Bookkeeping only: losing
    # the record of a metadata run costs one repeated resolve, and the names it
    # wrote are untouched.
    op.execute("DELETE FROM runs WHERE kind = 'instrument_metadata'")
    _replace_run_kind_check(PREVIOUS_KINDS)
