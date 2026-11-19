"""A trade proposed while the market is closed can be approved for the open (D398-D401).

Measured on production 2026-11-18: every one of the eight trade proposals since
2026-11-09 was raised while the market was closed, and 17 of the 22 refused
approvals were `market_closed`. Approve was the wrong button for all of them.

- **`proposals.opens_at`** is the exchange's next open when the proposal was
  raised while it was closed, from the same calendar answer that set
  `expires_at` (open + one hour, D4); null when the market was open. It is what
  a surface reads to offer *Approve at the open* instead of *Approve*, without a
  calendar call per proposal in a list.
- **`proposals.open_approval`** is what became of an approval for the open:
  `queued` until the open, then `filled`, `refused` (with the refusal's code in
  `open_approval_reason`), `cancelled` by the user, `expired` with it still
  waiting, or `superseded` by a newer proposal for the same agent and symbol
  (D400). The proposal itself stays `pending` until the fill approves it, so the
  state machine (F3) is unchanged. `open_approval_surface` and
  `open_approval_at` say where and when the user approved it.
- **`runs.kind`** gains `open_approvals`: the minute tick that fills them
  (D401). It writes a run only when an approval is due.
- **`notifications.ref_kind`** gains `open_approval`: the message saying what
  the open did with it, keyed by the proposal, so one is sent per proposal.

Downgrade drops the columns and deletes the runs and notifications of the new
kinds: they are bookkeeping, and a filled approval keeps its fill and its
transition to `approved`.

Revision ID: 0087_open_approval
Revises: 0086_assistant_proposal
"""

from alembic import op

revision = "0087_open_approval"
down_revision = "0086_assistant_proposal"
branch_labels = None
depends_on = None

#: What became of an approval for the open (`OPEN_APPROVAL_STATES` in TypeScript).
OPEN_APPROVAL_STATES = ("queued", "filled", "refused", "cancelled", "expired", "superseded")
#: The surfaces a user approves from: `proposal_attempts.surface`'s.
OPEN_APPROVAL_SURFACES = ("web", "telegram")

#: The run kinds before this migration (last changed by 0076).
PREVIOUS_KINDS = (
    "snapshot",
    "portfolio_scan",
    "topic_scan",
    "daily_digest",
    "backfill",
    "proposal_sweep",
    "instrument_metadata",
    "news_collect",
    "topic_discovery",
    "universe_rescreen",
    "agent_scans",
    "agent_scan",
    "research",
    "session_sweep",
    "auth_sweep",
    "account_erase",
)
KINDS = (*PREVIOUS_KINDS, "open_approvals")

#: 0073's notification referents.
PREVIOUS_REF_KINDS = ("observation", "proposal", "narration", "model_fallback", "run")
REF_KINDS = (*PREVIOUS_REF_KINDS, "open_approval")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _kinds(values: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check")
    op.execute(
        f"ALTER TABLE runs ADD CONSTRAINT runs_kind_check CHECK (kind IN ({_sql_list(values)}))"
    )


def _ref_kinds(values: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE notifications DROP CONSTRAINT notifications_ref_kind_check")
    op.execute(
        "ALTER TABLE notifications ADD CONSTRAINT notifications_ref_kind_check "
        f"CHECK (ref_kind IN ({_sql_list(values)}))"
    )


def upgrade() -> None:
    op.execute(
        f"""
        ALTER TABLE proposals
            ADD COLUMN opens_at timestamptz,
            ADD COLUMN open_approval text
                CONSTRAINT proposals_open_approval_check
                CHECK (open_approval IN ({_sql_list(OPEN_APPROVAL_STATES)})),
            ADD COLUMN open_approval_surface text
                CONSTRAINT proposals_open_approval_surface_check
                CHECK (open_approval_surface IN ({_sql_list(OPEN_APPROVAL_SURFACES)})),
            ADD COLUMN open_approval_at timestamptz,
            ADD COLUMN open_approval_reason text
                CONSTRAINT proposals_open_approval_reason_check
                CHECK (length(open_approval_reason) BETWEEN 1 AND 64),
            ADD CONSTRAINT proposals_open_approval_complete
                CHECK ((open_approval IS NULL) = (open_approval_surface IS NULL)
                   AND (open_approval IS NULL) = (open_approval_at IS NULL)),
            ADD CONSTRAINT proposals_open_approval_is_a_trades
                CHECK (open_approval IS NULL OR (opens_at IS NOT NULL AND kind IN ('buy', 'sell'))),
            ADD CONSTRAINT proposals_open_approval_reason_when_refused
                CHECK (open_approval_reason IS NULL OR open_approval = 'refused')
        """
    )
    # The tick's question, asked every minute: which approvals are waiting.
    op.execute(
        "CREATE INDEX proposals_open_approval_queued_idx ON proposals (opens_at) "
        "WHERE open_approval = 'queued'"
    )
    _kinds(KINDS)
    _ref_kinds(REF_KINDS)


def downgrade() -> None:
    op.execute("DELETE FROM notifications WHERE ref_kind = 'open_approval'")
    _ref_kinds(PREVIOUS_REF_KINDS)
    op.execute("DELETE FROM runs WHERE kind = 'open_approvals'")
    _kinds(PREVIOUS_KINDS)
    op.execute("DROP INDEX proposals_open_approval_queued_idx")
    op.execute(
        """
        ALTER TABLE proposals
            DROP CONSTRAINT proposals_open_approval_reason_when_refused,
            DROP CONSTRAINT proposals_open_approval_is_a_trades,
            DROP CONSTRAINT proposals_open_approval_complete,
            DROP COLUMN open_approval_reason,
            DROP COLUMN open_approval_at,
            DROP COLUMN open_approval_surface,
            DROP COLUMN open_approval,
            DROP COLUMN opens_at
        """
    )
