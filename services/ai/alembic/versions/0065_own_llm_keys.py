"""A user's own OpenRouter key, whose key paid for each call, and its failure (D206-D209).

`user_llm_keys` holds one saved key a user, encrypted with
`LLM_KEY_ENCRYPTION_KEYS` (`app/llm/key_vault.py`); only its last four
characters are stored in the clear. `status` is `failed` once OpenRouter has
refused it, with why (`rejected`: 401, `no_credit`: 402) and when.

`llm_calls.paid_by` says whose key a call was made with. Every existing row was
the installation's. The monthly cap sums `installation` rows only, so a user
who spent on their own key and then removed it is not capped for it.

`own_key_failed` joins the outcomes of a scan and of an assistant reply: the
user's key stopped working mid-way, and the screen says so and what follows.

The downgrade refuses while any own-key call, failure outcome or saved key
exists: 0064 cannot tell an own-key call from the installation's, and would
count it against the cap.

Revision ID: 0065_own_llm_keys
Revises: 0064_monthly_cap
"""

from alembic import op

revision = "0065_own_llm_keys"
down_revision = "0064_monthly_cap"
branch_labels = None
depends_on = None

#: 0064's scan outcomes; code Literals are tested against `SCAN_OUTCOMES`.
PREVIOUS_SCAN_OUTCOMES = (
    "trade",
    "no_trade",
    "invalid_answer",
    "budget_reached",
    "step_limit",
    "failed",
    "rule_rejected",
    "cap_reached",
)
SCAN_OUTCOMES = (*PREVIOUS_SCAN_OUTCOMES, "own_key_failed")

#: 0064's reply outcomes; code Literals are tested against `REPLY_OUTCOMES`.
PREVIOUS_REPLY_OUTCOMES = (
    "answer",
    "decline",
    "clarify",
    "failed",
    "budget_reached",
    "no_model",
    "cap_reached",
)
REPLY_OUTCOMES = (*PREVIOUS_REPLY_OUTCOMES, "own_key_failed")

PAID_BY = ("installation", "own_key")
KEY_STATUSES = ("valid", "failed")
KEY_FAILURES = ("rejected", "no_credit")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    op.execute(
        f"""
        CREATE TABLE user_llm_keys (
            user_id     uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
            ciphertext  text NOT NULL,
            last_four   text NOT NULL CHECK (char_length(last_four) = 4),
            status      text NOT NULL DEFAULT 'valid' CHECK (status IN ({_sql_list(KEY_STATUSES)})),
            failure     text CHECK (failure IN ({_sql_list(KEY_FAILURES)})),
            failed_at   timestamptz,
            saved_at    timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT user_llm_keys_failed_has_why CHECK (
                (status = 'failed') = (failure IS NOT NULL AND failed_at IS NOT NULL)
            )
        )
        """
    )
    op.execute(
        "ALTER TABLE llm_calls ADD COLUMN paid_by text NOT NULL DEFAULT 'installation' "
        f"CONSTRAINT llm_calls_paid_by_check CHECK (paid_by IN ({_sql_list(PAID_BY)}))"
    )
    _outcomes(SCAN_OUTCOMES, REPLY_OUTCOMES)


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM llm_calls WHERE paid_by = 'own_key')
               OR EXISTS (SELECT 1 FROM agent_scans WHERE outcome = 'own_key_failed')
               OR EXISTS (SELECT 1 FROM assistant_messages WHERE outcome = 'own_key_failed')
               OR EXISTS (SELECT 1 FROM user_llm_keys) THEN
                RAISE EXCEPTION 'own-key rows exist; 0064 would count them against the cap';
            END IF;
        END
        $$
        """
    )
    _outcomes(PREVIOUS_SCAN_OUTCOMES, PREVIOUS_REPLY_OUTCOMES)
    op.execute("ALTER TABLE llm_calls DROP COLUMN paid_by")
    op.execute("DROP TABLE user_llm_keys")


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
