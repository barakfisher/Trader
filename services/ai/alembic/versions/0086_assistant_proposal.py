"""Ask may draft an acknowledge-only proposal, written only by the user's tap (D393).

D387 case 4, as D393 builds it:

- **`assistant_messages.proposal_draft`** holds what the model drafted, on the
  reply that drafted it. It is not a proposal: nothing reaches the inbox, the
  ledger or Telegram's `/pending` until the user taps *Add to proposals*.
  `proposal_draft_state` says what became of it (`open`, `added`, `closed`), and
  `proposal_draft_proposal_id` names the proposal a tap led to. A draft's expiry
  is computed from the message's age, so it needs no sweep and no column.
- **The trigger** (0038's, widened by 0085) admits one more kind, `assistant`, on
  the same terms as `research`: on the primary agent only, with no quantity and
  no price, so it cannot become a fill. `buy` and `sell` stay refused there.

The proposal keeps the message's id in its payload rather than a foreign key, so
deleting a conversation - by hand or at 90 days - leaves the proposal and its
decisions standing.

The downgrade refuses while an `assistant` proposal exists: 0085's trigger would
refuse the row on its next update.

Revision ID: 0086_assistant_proposal
Revises: 0085_research_advice
"""

from alembic import op

revision = "0086_assistant_proposal"
down_revision = "0085_research_advice"
branch_labels = None
depends_on = None

#: The acknowledge-only kinds: on the primary only, never with a quantity or price.
PREVIOUS_ACKNOWLEDGED_KINDS = ("research",)
ACKNOWLEDGED_KINDS = (*PREVIOUS_ACKNOWLEDGED_KINDS, "assistant")
#: What the primary may receive: 0038's, and the acknowledge-only kinds.
PREVIOUS_PRIMARY_KINDS = ("rebalance", *PREVIOUS_ACKNOWLEDGED_KINDS)
PRIMARY_KINDS = ("rebalance", *ACKNOWLEDGED_KINDS)
DRAFT_STATES = ("open", "added", "closed")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _trigger_function(primary_kinds: tuple[str, ...], acknowledged: tuple[str, ...]) -> str:
    return f"""
        CREATE OR REPLACE FUNCTION proposals_primary_rebalance_only() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE
            primary_agent boolean;
        BEGIN
            SELECT is_primary INTO primary_agent FROM agents WHERE id = NEW.agent_id;
            IF coalesce(primary_agent, false) AND NEW.kind NOT IN ({_sql_list(primary_kinds)}) THEN
                RAISE EXCEPTION 'the primary agent is passive: a % proposal cannot be raised '
                    'against the real portfolio', NEW.kind
                    USING ERRCODE = 'check_violation';
            END IF;
            IF NEW.kind IN ({_sql_list(acknowledged)}) AND NOT coalesce(primary_agent, false) THEN
                RAISE EXCEPTION 'a % proposal is raised on the real portfolio only', NEW.kind
                    USING ERRCODE = 'check_violation';
            END IF;
            IF NEW.kind IN ({_sql_list(acknowledged)})
               AND (NEW.payload ? 'quantity' OR NEW.payload ? 'priceMinor') THEN
                RAISE EXCEPTION 'a % proposal is acknowledged, never filled: '
                    'it carries no quantity or price', NEW.kind
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$
        """


def upgrade() -> None:
    op.execute(
        f"""
        ALTER TABLE assistant_messages
            ADD COLUMN proposal_draft jsonb,
            ADD COLUMN proposal_draft_state text
                CHECK (proposal_draft_state IN ({_sql_list(DRAFT_STATES)})),
            ADD COLUMN proposal_draft_proposal_id uuid
                REFERENCES proposals (id) ON DELETE SET NULL,
            ADD CONSTRAINT assistant_messages_draft_has_a_state
                CHECK ((proposal_draft IS NULL) = (proposal_draft_state IS NULL)),
            ADD CONSTRAINT assistant_messages_draft_is_an_answers
                CHECK (proposal_draft IS NULL OR outcome = 'answer')
        """
    )
    op.execute(_trigger_function(PRIMARY_KINDS, ACKNOWLEDGED_KINDS))


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM proposals WHERE kind = 'assistant') THEN
                RAISE EXCEPTION 'assistant proposals exist; 0085''s trigger would refuse them';
            END IF;
        END;
        $$
        """
    )
    op.execute(_trigger_function(PREVIOUS_PRIMARY_KINDS, PREVIOUS_ACKNOWLEDGED_KINDS))
    op.execute(
        """
        ALTER TABLE assistant_messages
            DROP CONSTRAINT assistant_messages_draft_is_an_answers,
            DROP CONSTRAINT assistant_messages_draft_has_a_state,
            DROP COLUMN proposal_draft_proposal_id,
            DROP COLUMN proposal_draft_state,
            DROP COLUMN proposal_draft
        """
    )
