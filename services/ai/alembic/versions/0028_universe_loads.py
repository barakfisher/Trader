"""`universe_loads`: what each load of the universe snapshot found and did (M8).

The admin page shows the universe's status - how many members the snapshot
has, how many the database holds, how many ETF holdings - and must be able to
say *why* those differ. The differences are all known to the loader when it
runs: members without a description, holdings whose weight is not a fraction
of the fund, holdings of a fund with no profile. Until now it printed them and
forgot them, so the only way to reconcile the page's numbers was to re-derive
the loader's reasoning somewhere else (decision 86).

One row per run of `scripts/ingest_universe.py`: the snapshot's own manifest,
copied as it was read, beside the loader's counts. Append-only by use, not by
trigger - it is a record of the installation, not of anyone's action.

Revision ID: 0028_universe_loads
Revises: 0027_ops_events
"""

from alembic import op

revision = "0028_universe_loads"
down_revision = "0027_ops_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE universe_loads (
            id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            snapshot_as_of  timestamptz NOT NULL,
            source          text NOT NULL,
            manifest        jsonb NOT NULL,
            report          jsonb NOT NULL,
            loaded_at       timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX universe_loads_recent_idx ON universe_loads (loaded_at DESC)")


def downgrade() -> None:
    op.execute("DROP TABLE universe_loads")
