"""`agent_scans`: one row per scan an agent ran, holding its whole transcript (D15, D50).

Stage 4, PR 4 (docs/PROPOSAL-MULTI-AGENT.md D10, D14, D15, D50, §14.2).

A scan is the agent's decision log: the briefing it was given, every tool call
and its result, and its answer. D50 shows each one on the agent's *Decisions*
tab, scans that traded nothing included - the money spent on "no trade" and the
reasoning behind an agent that never acts are the point of the log.

**`outcome` is NULL while the scan runs.** One running scan per agent, by a
partial unique index: a second "run a scan now" while one is in flight is a
409, not a second bill. A scan the process never finished (a crash, a deploy)
would hold that slot forever, so the scan code marks one older than its own
time limit `failed` before starting the next.

**Outcomes** - `trade`: the agent decided to buy or sell, and its answer passed
the server's checks (it becomes a proposal in PR 5, which adds the link);
`no_trade`: it decided nothing was worth doing, the expected outcome of most
scans; `invalid_answer`: it answered, and the answer failed the checks (D14)
or did not parse; `budget_reached`: the agent's daily LLM budget (D45) or the
installation's spend guard stopped it; `step_limit`: it was still asking for
tools at the last step; `failed`: a provider or tool error ended it.

**The transcript is stored whole** (`jsonb`), as the model saw it, because D15
makes it the evidence a thesis is validated against and D50 shows it verbatim.
Not normalised into a row per step: nothing queries inside a transcript, and a
scan is read and written as one unit.

Append-only for the app role apart from finishing the row it started: a log
that could be rewritten afterwards would not be a log.

Revision ID: 0043_agent_scans
Revises: 0042_agent_scan_inputs
"""

from alembic import op

revision = "0043_agent_scans"
down_revision = "0042_agent_scan_inputs"
branch_labels = None
depends_on = None

APP_ROLE = "traders_app"

#: The values the CHECKs below admit; code Literals are tested against them.
OUTCOMES = ("trade", "no_trade", "invalid_answer", "budget_reached", "step_limit", "failed")
TRIGGERS = ("manual", "schedule")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    op.execute(
        f"""
        CREATE TABLE agent_scans (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL REFERENCES users (id),
            agent_id uuid NOT NULL,
            trigger text NOT NULL CHECK (trigger IN ({_sql_list(TRIGGERS)})),
            started_at timestamptz NOT NULL DEFAULT now(),
            finished_at timestamptz,
            outcome text CHECK (outcome IN ({_sql_list(OUTCOMES)})),
            steps integer NOT NULL DEFAULT 0 CHECK (steps >= 0),
            cost_micro_usd bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
            model text,
            briefing jsonb NOT NULL,
            transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
            answer jsonb,
            error text,
            FOREIGN KEY (user_id, agent_id) REFERENCES agents (user_id, id),
            CONSTRAINT agent_scans_finished_has_outcome
                CHECK ((finished_at IS NULL) = (outcome IS NULL)),
            CONSTRAINT agent_scans_transcript_is_list
                CHECK (jsonb_typeof(transcript) = 'array')
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX agent_scans_one_running ON agent_scans (agent_id) "
        "WHERE finished_at IS NULL"
    )
    op.execute("CREATE INDEX agent_scans_agent_idx ON agent_scans (agent_id, started_at DESC)")
    # A scan is only for a simulated agent: the primary is passive (D1).
    op.execute(
        """
        CREATE FUNCTION agent_scans_refuse_primary() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF EXISTS (SELECT 1 FROM agents WHERE id = NEW.agent_id AND is_primary) THEN
                RAISE EXCEPTION 'the primary agent does not scan (D1)'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER agent_scans_refuse_primary
            BEFORE INSERT ON agent_scans
            FOR EACH ROW EXECUTE FUNCTION agent_scans_refuse_primary()
        """
    )
    op.execute(f"REVOKE DELETE ON agent_scans FROM {APP_ROLE}")


def downgrade() -> None:
    op.execute("DROP TRIGGER agent_scans_refuse_primary ON agent_scans")
    op.execute("DROP FUNCTION agent_scans_refuse_primary()")
    op.execute("DROP TABLE agent_scans")
