"""The primary agent is passive: it is asked to acknowledge, never to trade (decision D1).

`docs/PROPOSAL-MULTI-AGENT.md` §10 D1. "Main portfolio" holds the user's real,
imported portfolio and is never the subject of a trade proposal - at any stage,
under any circumstances. The one proposal it receives today, `rebalance`, is an
acknowledgement that an allocation drifted (its payload is the observation kind
and the subject, no side, no quantity, no fill), and it stays.

Three layers enforce this, so a bug in one is caught by the next:
`agents_primary_is_real` (0036) keeps the primary from holding a budget or a
persona; `services/proposals.ts` refuses before writing; and this trigger
refuses any proposal kind other than `rebalance` against a primary, whatever
wrote it. No trade kind exists yet - the trigger is in place before the first
one is written, which is the only time it can be added without a backfill.

An allowlist rather than a denylist: a future kind is refused on the real
portfolio until someone argues, in a migration, that it belongs there.

Revision ID: 0038_primary_is_passive
Revises: 0037_per_agent_uniques
"""

from alembic import op

revision = "0038_primary_is_passive"
down_revision = "0037_per_agent_uniques"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE FUNCTION proposals_primary_rebalance_only() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF NEW.kind <> 'rebalance'
               AND EXISTS (SELECT 1 FROM agents WHERE id = NEW.agent_id AND is_primary) THEN
                RAISE EXCEPTION 'the primary agent is passive: a % proposal cannot be raised '
                    'against the real portfolio', NEW.kind
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER proposals_primary_rebalance_only
            BEFORE INSERT OR UPDATE OF kind, agent_id ON proposals
            FOR EACH ROW EXECUTE FUNCTION proposals_primary_rebalance_only()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER proposals_primary_rebalance_only ON proposals")
    op.execute("DROP FUNCTION proposals_primary_rebalance_only()")
