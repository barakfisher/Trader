"""Record how complete each portfolio snapshot was (Milestone 1 follow-up).

A snapshot is a historical fact: one row per user per day, deliberately
denormalised and never recomputed. The only defence so far was a refusal to write
when *nothing* could be priced, so a day on which 9 of 10 holdings priced was
stored as a smaller total with no trace of what was missing - indistinguishable
from a real loss, and the input M2's volatility and drawdown rules read.

These columns make that provenance part of the row, so a consumer can tell a
complete total from a partial one. Rows written before this migration keep the
defaults; `holdings_count = 0` against a non-zero `total_minor` is how a row of
unknown provenance looks, and it is not mistakable for a measurement.

Revision ID: 0002_snapshot_integrity
Revises: 0001_initial_portfolio
"""

from alembic import op

revision = "0002_snapshot_integrity"
down_revision = "0001_initial_portfolio"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE portfolio_snapshots
            -- Holdings the user owned on `as_of`, priced or not.
            ADD COLUMN holdings_count integer NOT NULL DEFAULT 0,
            -- Of those, how many contributed a value to `total_minor`. When this
            -- is lower than holdings_count the total is understated by exactly
            -- the missing positions, which is the whole point of storing it.
            ADD COLUMN priced_count integer NOT NULL DEFAULT 0,
            -- True when any holding was unpriced or any quote was served stale.
            -- Wider than `priced_count < holdings_count`: a stale but usable
            -- quote keeps the counts equal while still making the total
            -- approximate, so consumers get one flag to gate on.
            ADD COLUMN degraded boolean NOT NULL DEFAULT false
        """
    )

    # Rows written before these columns existed carry the defaults, which would
    # read as "complete, fully priced, nothing missing" - a claim we cannot
    # support. We do not know how many holdings those snapshots covered or
    # whether every one of them was priced, so they are marked degraded: unknown
    # provenance is closer to degraded than to trustworthy, and Milestone 2
    # treating an unverifiable total as solid evidence is precisely the failure
    # this migration exists to prevent. `holdings_count = 0` identifies them
    # exactly, because every row written from now on records a real count and a
    # snapshot of an empty portfolio is never stored.
    op.execute(
        """
        UPDATE portfolio_snapshots
           SET degraded = true
         WHERE holdings_count = 0
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE portfolio_snapshots
            DROP COLUMN degraded,
            DROP COLUMN priced_count,
            DROP COLUMN holdings_count
        """
    )
