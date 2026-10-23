"""Own key only: a user's optional monthly safety limit, and the refusal for no key (D245, D250).

`user_settings.llm_safety_limit_micro_usd` is a user's own monthly ceiling on
what this app spends on their key, integer micro-USD; NULL is no limit. It is
counted in the user's calendar month over `llm_calls` rows `paid_by =
'own_key'` (`app/llm/payer.py`), and reaching it ends a scan or a reply as
`cap_reached`, the outcome the retired monthly cap left behind (D269).

`own_key_required` joins the outcomes of a scan and of an assistant reply: a
user who is not the admin asked for a model call with no working key of their
own, and nothing falls back to the installation's key (D245). Like the other
refusals, a re-check that ends with it reached no answer and does not use the
proposal's one re-check up (D213), so `agent_scans_one_refresh` is rebuilt
without it.

The downgrade refuses while any `own_key_required` row exists; a set safety
limit is dropped with its column, which loses only a preference.

Revision ID: 0068_own_key_only
Revises: 0067_telegram_conversation
"""

from alembic import op

revision = "0068_own_key_only"
down_revision = "0067_telegram_conversation"
branch_labels = None
depends_on = None

#: The largest safety limit a user may set: $1,000 a month, the admin cap's ceiling (0058).
SAFETY_LIMIT_CEILING_MICRO_USD = 1_000_000_000

#: 0065's scan outcomes; code Literals are tested against `SCAN_OUTCOMES`.
PREVIOUS_SCAN_OUTCOMES = (
    "trade",
    "no_trade",
    "invalid_answer",
    "budget_reached",
    "step_limit",
    "failed",
    "rule_rejected",
    "cap_reached",
    "own_key_failed",
)
SCAN_OUTCOMES = (*PREVIOUS_SCAN_OUTCOMES, "own_key_required")

#: 0065's reply outcomes; code Literals are tested against `REPLY_OUTCOMES`.
PREVIOUS_REPLY_OUTCOMES = (
    "answer",
    "decline",
    "clarify",
    "failed",
    "budget_reached",
    "no_model",
    "cap_reached",
    "own_key_failed",
)
REPLY_OUTCOMES = (*PREVIOUS_REPLY_OUTCOMES, "own_key_required")

#: 0066's re-checks that reached no answer; `recheck.UNANSWERED_OUTCOMES` is tested against these.
PREVIOUS_UNANSWERED_OUTCOMES = ("failed", "budget_reached", "cap_reached", "own_key_failed")
UNANSWERED_OUTCOMES = (*PREVIOUS_UNANSWERED_OUTCOMES, "own_key_required")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    op.execute(
        "ALTER TABLE user_settings ADD COLUMN llm_safety_limit_micro_usd bigint "
        "CONSTRAINT user_settings_llm_safety_limit_check CHECK ("
        "llm_safety_limit_micro_usd > 0 AND "
        f"llm_safety_limit_micro_usd <= {SAFETY_LIMIT_CEILING_MICRO_USD})"
    )
    _outcomes(SCAN_OUTCOMES, REPLY_OUTCOMES)
    _one_refresh(UNANSWERED_OUTCOMES)


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM agent_scans WHERE outcome = 'own_key_required')
               OR EXISTS (SELECT 1 FROM assistant_messages WHERE outcome = 'own_key_required') THEN
                RAISE EXCEPTION 'own_key_required rows exist; 0067 cannot name them';
            END IF;
        END
        $$
        """
    )
    _one_refresh(PREVIOUS_UNANSWERED_OUTCOMES)
    _outcomes(PREVIOUS_SCAN_OUTCOMES, PREVIOUS_REPLY_OUTCOMES)
    op.execute("ALTER TABLE user_settings DROP COLUMN llm_safety_limit_micro_usd")


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


def _one_refresh(unanswered: tuple[str, ...]) -> None:
    op.execute("DROP INDEX agent_scans_one_refresh")
    op.execute(
        "CREATE UNIQUE INDEX agent_scans_one_refresh ON agent_scans (refreshes_proposal_id) "
        f"WHERE outcome IS NULL OR outcome NOT IN ({_sql_list(unanswered)})"
    )
