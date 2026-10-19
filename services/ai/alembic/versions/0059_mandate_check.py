"""The contradiction check: its own LLM purpose, and its result on the agent (D176-D178).

After a save whose instructions are the user's own words (not the text the form
wrote from the settings), the page asks once whether those words contradict the
mandate. This revision gives that call a home:

- **`mandate_check`, an `llm_calls` purpose** (D177). It follows the agents'
  model choice and counts against the agent's daily model budget beside its
  scans, but is never summed into a scan's cost: the Decisions tab and D46's
  per-scan estimate read `agent_scans`, which a check never writes.
  `llm_calls_scan_names_its_agent` (0042) widens to match: a call names an
  agent exactly when it is one of the agent's own - a scan or a check.
- **`agents.instructions_check`** (D178): the last result, as
  `{fingerprint, conflicts, checked_at, dismissed}`. The fingerprint is of the
  instructions and the mandate the check judged (`instructionsCheck.ts` computes
  it), so a result is shown only while both are unchanged and the user has not
  dismissed it. Null until the first check, and for the primary, which has no
  instructions to check (D1).

Revision ID: 0059_mandate_check
Revises: 0058_user_accounts
"""

from alembic import op

revision = "0059_mandate_check"
down_revision = "0058_user_accounts"
branch_labels = None
depends_on = None

#: 0052's purposes; `test_llm_call_log.py` holds `PURPOSES` equal to `Purpose` in code.
PREVIOUS_PURPOSES = ("narration", "ask", "agent_scan", "assistant")
PURPOSES = (*PREVIOUS_PURPOSES, "mandate_check")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _purposes(values: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_purpose_check")
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_purpose_check "
        f"CHECK (purpose IN ({_sql_list(values)}))"
    )


def _agent_purposes(values: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_scan_names_its_agent")
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_scan_names_its_agent "
        f"CHECK ((purpose IN ({_sql_list(values)})) = (agent_id IS NOT NULL))"
    )


def upgrade() -> None:
    _purposes(PURPOSES)
    _agent_purposes(("agent_scan", "mandate_check"))
    op.execute(
        """
        ALTER TABLE agents
            ADD COLUMN instructions_check jsonb
                CHECK (instructions_check IS NULL OR jsonb_typeof(instructions_check) = 'object'),
            ADD CONSTRAINT agents_primary_has_no_instructions_check
                CHECK (NOT is_primary OR instructions_check IS NULL)
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE agents
            DROP CONSTRAINT agents_primary_has_no_instructions_check,
            DROP COLUMN instructions_check
        """
    )
    # A check's calls are spend records; 0058 cannot name their purpose, and
    # relabelling them as scans would put them in the scan averages.
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM llm_calls WHERE purpose = 'mandate_check') THEN
                RAISE EXCEPTION 'llm_calls holds mandate_check calls; 0058 cannot describe them';
            END IF;
        END
        $$
        """
    )
    _agent_purposes(("agent_scan",))
    _purposes(PREVIOUS_PURPOSES)
