"""An approval can be withdrawn, and the ledger remembers that it was.

`intents` was written as append-only with one row per proposal, enforced by
`intents_one_per_proposal UNIQUE (proposal_id)`. Undo breaks the second half of
that and must not break the first.

**A withdrawn approval is marked, never deleted.** `revoked_at` and
`revoked_via` record when and from where assent was withdrawn. Deleting the row
would make the ledger say the user never approved, which is false - they
approved at 10:02 and withdrew at 10:05, and both halves are the record. The
transition that caused it is in `proposal_transitions` as `approved -> pending`.

**One *live* intent per proposal, not one intent.** Undo returns the proposal
to `pending`, so the user may approve it again, and that approval needs a row of
its own. The table-wide unique constraint becomes a partial unique index over
unrevoked rows: the guarantee it existed for - a second tap on Approve cannot
write a second ledger row - is exactly as strong, because a second tap finds a
live row and loses the index.

`revoked_via` has no `'system'`: nothing but a person withdraws assent. The
expiry sweep never touches an approved proposal.

Revision ID: 0014_intent_revocation
Revises: 0013_kb_embeddings
"""

from alembic import op

revision = "0014_intent_revocation"
down_revision = "0013_kb_embeddings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE intents
            ADD COLUMN revoked_at  timestamptz,
            ADD COLUMN revoked_via text CHECK (revoked_via IN ('web','telegram')),
            ADD CONSTRAINT intents_revocation_complete
                CHECK ((revoked_at IS NULL) = (revoked_via IS NULL))
        """
    )
    op.execute("ALTER TABLE intents DROP CONSTRAINT intents_one_per_proposal")
    op.execute(
        """
        CREATE UNIQUE INDEX intents_one_live_per_proposal
            ON intents (proposal_id) WHERE revoked_at IS NULL
        """
    )


def downgrade() -> None:
    # Revoked rows cannot survive the old constraint alongside a later live one,
    # and silently dropping them would erase history on the way down. Refuse
    # instead, so the operator decides what that history is worth.
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM intents WHERE revoked_at IS NOT NULL) THEN
                RAISE EXCEPTION 'intents holds revoked rows; downgrading would discard them';
            END IF;
        END $$
        """
    )
    op.execute("DROP INDEX IF EXISTS intents_one_live_per_proposal")
    op.execute("ALTER TABLE intents ADD CONSTRAINT intents_one_per_proposal UNIQUE (proposal_id)")
    op.execute(
        """
        ALTER TABLE intents
            DROP CONSTRAINT intents_revocation_complete,
            DROP COLUMN revoked_via,
            DROP COLUMN revoked_at
        """
    )
