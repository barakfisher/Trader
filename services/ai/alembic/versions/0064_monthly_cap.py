"""The monthly cap's refusal is an outcome of its own, and its sum is indexed (D157, D158, D205).

`cap_reached` joins the outcomes of an agent scan (`agent_scans`) and of an
assistant reply (`assistant_messages`). A scan or a question refused because the
user's month is spent is not "today's budget": it resets on a different day, and
the screen says which, so the two cannot share `budget_reached`.

`llm_calls_user_month` serves the check made before every call of a capped
user - `sum(cost_micro_usd)` for one user since their month began. 0052's
`llm_calls_assistant_spend` covers the same columns for one purpose only.

The downgrade refuses while any row holds `cap_reached`: 0063 has no word for
it, and rewriting it to `budget_reached` would say the wrong reset.

Revision ID: 0064_monthly_cap
Revises: 0063_agent_total_ceiling
"""

from alembic import op

revision = "0064_monthly_cap"
down_revision = "0063_agent_total_ceiling"
branch_labels = None
depends_on = None

#: 0057's scan outcomes; code Literals are tested against `SCAN_OUTCOMES`.
PREVIOUS_SCAN_OUTCOMES = (
    "trade",
    "no_trade",
    "invalid_answer",
    "budget_reached",
    "step_limit",
    "failed",
    "rule_rejected",
)
SCAN_OUTCOMES = (*PREVIOUS_SCAN_OUTCOMES, "cap_reached")

#: 0052's reply outcomes; code Literals are tested against `REPLY_OUTCOMES`.
PREVIOUS_REPLY_OUTCOMES = ("answer", "decline", "clarify", "failed", "budget_reached", "no_model")
REPLY_OUTCOMES = (*PREVIOUS_REPLY_OUTCOMES, "cap_reached")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    _outcomes(SCAN_OUTCOMES, REPLY_OUTCOMES)
    op.execute("CREATE INDEX llm_calls_user_month ON llm_calls (user_id, started_at)")


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM agent_scans WHERE outcome = 'cap_reached')
               OR EXISTS (SELECT 1 FROM assistant_messages WHERE outcome = 'cap_reached') THEN
                RAISE EXCEPTION 'cap_reached rows exist; 0063 cannot describe them';
            END IF;
        END
        $$
        """
    )
    op.execute("DROP INDEX llm_calls_user_month")
    _outcomes(PREVIOUS_SCAN_OUTCOMES, PREVIOUS_REPLY_OUTCOMES)


def _outcomes(scans: tuple[str, ...], replies: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE agent_scans DROP CONSTRAINT agent_scans_outcome_check")
    op.execute(
        "ALTER TABLE agent_scans ADD CONSTRAINT agent_scans_outcome_check "
        f"CHECK (outcome IN ({_sql_list(scans)}))"
    )
    op.execute("ALTER TABLE assistant_messages DROP CONSTRAINT assistant_messages_outcome_check")
    op.execute(
        "ALTER TABLE assistant_messages ADD CONSTRAINT assistant_messages_outcome_check "
        f"CHECK (outcome IN ({_sql_list(replies)}))"
    )
