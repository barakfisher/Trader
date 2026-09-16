"""Allow 'backfill' as a run kind.

`runs.kind` is constrained to a known list, which caught this: the backfill run
was written, tested and deployed, and the first real trigger failed on the CHECK
rather than quietly writing a row with a kind nothing else recognises.

That friction is the point. A typo like 'portfolioScan' would otherwise become a
run nobody queries and a schedule nobody notices is broken, and the cost of the
constraint is one migration per new kind - which is rare, and deliberate.

Revision ID: 0005_backfill_run_kind
Revises: 0004_news
"""

from alembic import op

revision = "0005_backfill_run_kind"
down_revision = "0004_news"
branch_labels = None
depends_on = None

#: Kinds after this migration. Keep in step with the zod enum in the
#: orchestrator's internal route; the database is the one that enforces it.
KINDS = ("snapshot", "portfolio_scan", "topic_scan", "daily_digest", "backfill")


def upgrade() -> None:
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check")
    op.execute(
        f"ALTER TABLE runs ADD CONSTRAINT runs_kind_check "
        f"CHECK (kind IN ({', '.join(repr(kind) for kind in KINDS)}))"
    )


def downgrade() -> None:
    # Rows of the removed kind would violate the restored constraint, so they go
    # with it. A backfill run is bookkeeping: losing the record of one costs a
    # duplicate fetch, and the quotes it wrote are untouched.
    op.execute("DELETE FROM runs WHERE kind = 'backfill'")
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check")
    op.execute(
        "ALTER TABLE runs ADD CONSTRAINT runs_kind_check "
        "CHECK (kind IN ('snapshot','portfolio_scan','topic_scan','daily_digest'))"
    )
