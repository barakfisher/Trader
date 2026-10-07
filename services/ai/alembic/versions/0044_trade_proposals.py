"""Trade proposals: a scan's buy or sell, waiting for the user (Stage 4, PR 5a).

`docs/PROPOSAL-MULTI-AGENT.md` D26, D47-D49, D54-D58. Until now a scan's answer
was stored and nothing more; from here a `trade` scan becomes an observation
carrying its thesis and a `buy` or `sell` proposal hanging from it, which the
user approves - through a preview at the live price, then a confirm that fills
through `executeFill` - or rejects.

- **`proposals.scan_id`**: the scan that wrote a trade proposal. The link lives
  on the proposal, not on `agent_scans`, so the scan's row stays as the scan
  wrote it (0043: the app role only finishes its own row) and the proposal is
  written once, with its origin, in one insert. Unique: a scan proposes at most
  once (D15). **A trade kind has a scan and nothing else does**, by CHECK - a
  `buy` with no scan behind it is a trade nobody decided.
- **D1, unchanged:** the primary's allowlist trigger (0038) already refuses a
  `buy` or `sell` on the real portfolio; this migration does not touch it.
- **`fills`: an agent's fill has a proposal** (`source <> 'agent' OR
  proposal_id IS NOT NULL`) - the debt row from Stage 3. Every fill the agent
  is credited with is one the user approved; a manual trade still has none
  (0040's `fills_manual_has_no_proposal`).
- **`proposal_attempts`**: an approval that was refused (D49) - the live price
  too far from the agent's, the exchange closed, a stale quote, not enough cash.
  Nothing reaches the ledger and the proposal stays pending; this row is what
  its history shows of the attempt, with both prices. `reason` is free text on
  purpose: it is the code's refusal code, a closed set in TypeScript
  (`services/tradeApproval.ts`), and a new refusal must never be unable to
  record itself. Append-only for the app role, like every log here.

The downgrade refuses while a trade proposal exists: it would drop the scan
behind each one, and an upgrade back could not restore it - a `buy` with no
scan is exactly what the CHECK above forbids.

Revision ID: 0044_trade_proposals
Revises: 0043_agent_scans
"""

from alembic import op

revision = "0044_trade_proposals"
down_revision = "0043_agent_scans"
branch_labels = None
depends_on = None

APP_ROLE = "traders_app"

#: The proposal kinds a scan writes; code Literals are tested against it.
TRADE_KINDS = ("buy", "sell")
#: Where an approval is attempted from.
ATTEMPT_SURFACES = ("web", "telegram")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    op.execute("ALTER TABLE proposals ADD COLUMN scan_id uuid REFERENCES agent_scans (id)")
    op.execute(
        "CREATE UNIQUE INDEX proposals_one_per_scan ON proposals (scan_id) "
        "WHERE scan_id IS NOT NULL"
    )
    op.execute(
        f"""
        ALTER TABLE proposals ADD CONSTRAINT proposals_trade_has_scan
            CHECK ((kind IN ({_sql_list(TRADE_KINDS)})) = (scan_id IS NOT NULL))
        """
    )
    op.execute(
        """
        ALTER TABLE fills ADD CONSTRAINT fills_agent_has_proposal
            CHECK (source <> 'agent' OR proposal_id IS NOT NULL)
        """
    )
    op.execute(
        f"""
        CREATE TABLE proposal_attempts (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL REFERENCES users (id),
            proposal_id uuid NOT NULL REFERENCES proposals (id) ON DELETE CASCADE,
            surface text NOT NULL CHECK (surface IN ({_sql_list(ATTEMPT_SURFACES)})),
            reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 64),
            -- The agent's price is the proposal's; the live one is what the
            -- attempt saw, null when no price could be read at all.
            agent_price_minor bigint NOT NULL CHECK (agent_price_minor > 0),
            live_price_minor bigint CHECK (live_price_minor > 0),
            quote_as_of timestamptz,
            created_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        "CREATE INDEX proposal_attempts_proposal_idx "
        "ON proposal_attempts (proposal_id, created_at DESC)"
    )
    op.execute(f"REVOKE UPDATE, DELETE, TRUNCATE ON proposal_attempts FROM {APP_ROLE}")


def downgrade() -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM proposals WHERE kind IN ({_sql_list(TRADE_KINDS)})) THEN
                RAISE EXCEPTION 'proposals holds trade proposals; downgrading would discard '
                    'the scan behind each one';
            END IF;
        END
        $$
        """
    )
    op.execute("DROP TABLE proposal_attempts")
    op.execute("ALTER TABLE fills DROP CONSTRAINT fills_agent_has_proposal")
    op.execute("ALTER TABLE proposals DROP CONSTRAINT proposals_trade_has_scan")
    op.execute("DROP INDEX proposals_one_per_scan")
    op.execute("ALTER TABLE proposals DROP COLUMN scan_id")
