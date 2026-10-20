"""Several trades a scan: the agent's limit, and a proposal per trade (D197).

- **`agents.max_decisions`** - trades one answer may decide, 1 to 10. Existing
  agents get 1, so nothing changes until the user raises it.
- **`proposals_one_per_scan` becomes one per scan and symbol.** A scan that
  decided to sell XOM and buy CCJ writes two proposals, each approved on its own
  (D197); an answer names a symbol at most once, and the index holds that.

The downgrade refuses while a scan has more than one proposal - the old index
could not hold them - rather than deleting a user's proposals.

Revision ID: 0061_max_decisions
Revises: 0060_scan_every_hours
"""

from alembic import op

revision = "0061_max_decisions"
down_revision = "0060_scan_every_hours"
branch_labels = None
depends_on = None

#: `MIN_DECISIONS_PER_SCAN` / `MAX_DECISIONS_PER_SCAN` in `packages/shared/src/types.ts`.
MIN_DECISIONS = 1
MAX_DECISIONS = 10


def upgrade() -> None:
    op.execute(
        "ALTER TABLE agents ADD COLUMN max_decisions smallint NOT NULL DEFAULT 1 "
        f"CHECK (max_decisions BETWEEN {MIN_DECISIONS} AND {MAX_DECISIONS})"
    )
    op.execute("DROP INDEX proposals_one_per_scan")
    op.execute(
        "CREATE UNIQUE INDEX proposals_one_per_scan_symbol ON proposals "
        "(scan_id, (payload ->> 'symbol')) WHERE scan_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM proposals WHERE scan_id IS NOT NULL
                        GROUP BY scan_id HAVING count(*) > 1) THEN
                RAISE EXCEPTION 'a scan has more than one proposal; one per scan cannot hold them';
            END IF;
        END;
        $$
        """
    )
    op.execute("DROP INDEX proposals_one_per_scan_symbol")
    op.execute(
        "CREATE UNIQUE INDEX proposals_one_per_scan ON proposals (scan_id) "
        "WHERE scan_id IS NOT NULL"
    )
    op.execute("ALTER TABLE agents DROP COLUMN max_decisions")
