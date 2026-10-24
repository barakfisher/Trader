"""Research on the main portfolio: the assigned agent, its runs and its ratings (D254, D289-D293).

- **`user_settings.research_agent_id`**: the one agent a user assigned to
  research their main portfolio (D254's "one at a time"). NULL is none. The
  composite key keeps it the user's own agent; deleting the agent clears only
  this column (`SET NULL (research_agent_id)`, Postgres 15+), never the user.
- **`research_runs`**: one run of that agent over the main portfolio's holdings,
  asked for now or by the daily plan (D290). At most one runs per user at a
  time (`research_runs_one_running`); a run left `running` by a restart is
  closed out by the next claim (`app/research/store.py`).
- **`research_ratings`**: one row per holding per run - `rated` with a
  Bullish / Bearish / Neutral rating, the rationale and its findings, or
  `refused` (the wording or figure checks failed, D292) or `failed` (the call
  did not complete), each with its problems. The Dashboard shows the latest
  `rated` row per instrument of the assigned agent.
- **`research`, an `llm_calls` purpose**: the agent's own call, on the agent's
  model (`agents.model`, D284), counted against the agent's daily allowance
  beside its scans (D45), so `llm_calls_scan_names_its_agent` widens with it.
- **`research`, a run kind**: one attempt of the daily plan's research slot,
  the way `agent_scan` is one attempt of a scan slot (0048). Planned inside the
  15-minute `agent_scans` ask, so no new CronJob (D290).

The downgrade refuses while research calls are recorded, as 0059 does for its
purpose: they are spend records 0069 cannot name.

Revision ID: 0070_holding_research
Revises: 0069_model_choice
"""

from alembic import op

revision = "0070_holding_research"
down_revision = "0069_model_choice"
branch_labels = None
depends_on = None

#: 0059's purposes; `test_llm_call_log.py` holds `PURPOSES` equal to `Purpose` in code.
PREVIOUS_PURPOSES = ("narration", "ask", "agent_scan", "assistant", "mandate_check")
PURPOSES = (*PREVIOUS_PURPOSES, "research")
#: The purposes that name their agent (0059), and research.
PREVIOUS_AGENT_PURPOSES = ("agent_scan", "mandate_check")
AGENT_PURPOSES = (*PREVIOUS_AGENT_PURPOSES, "research")

#: 0048's run kinds.
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
)
KINDS = (*PREVIOUS_KINDS, "research")

#: `app/research/rating.py` RATINGS; the web's `SENTIMENT_RATINGS` says the same.
RATINGS = ("bullish", "bearish", "neutral")
RATING_STATUSES = ("rated", "refused", "failed")
TRIGGERS = ("manual", "schedule")
RUN_STATUSES = ("running", "done", "failed")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _purposes(values: tuple[str, ...], agent_values: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_purpose_check")
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_purpose_check "
        f"CHECK (purpose IN ({_sql_list(values)}))"
    )
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_scan_names_its_agent")
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_scan_names_its_agent "
        f"CHECK ((purpose IN ({_sql_list(agent_values)})) = (agent_id IS NOT NULL))"
    )


def _kinds(values: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check")
    op.execute(
        f"ALTER TABLE runs ADD CONSTRAINT runs_kind_check CHECK (kind IN ({_sql_list(values)}))"
    )


def upgrade() -> None:
    _purposes(PURPOSES, AGENT_PURPOSES)
    _kinds(KINDS)
    op.execute(
        """
        ALTER TABLE user_settings
            ADD COLUMN research_agent_id uuid,
            ADD CONSTRAINT user_settings_research_agent_fkey
                FOREIGN KEY (user_id, research_agent_id) REFERENCES agents(user_id, id)
                ON DELETE SET NULL (research_agent_id)
        """
    )
    op.execute(
        f"""
        CREATE TABLE research_runs (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            agent_id        uuid NOT NULL,
            trigger         text NOT NULL CHECK (trigger IN ({_sql_list(TRIGGERS)})),
            status          text NOT NULL DEFAULT 'running'
                            CHECK (status IN ({_sql_list(RUN_STATUSES)})),
            holdings        integer NOT NULL DEFAULT 0 CHECK (holdings >= 0),
            rated           integer NOT NULL DEFAULT 0 CHECK (rated >= 0),
            cost_micro_usd  bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
            -- Why a run stopped early or failed, in English, for the research page's detail.
            error           text,
            started_at      timestamptz NOT NULL DEFAULT now(),
            finished_at     timestamptz,
            FOREIGN KEY (user_id, agent_id) REFERENCES agents(user_id, id) ON DELETE CASCADE,
            CONSTRAINT research_runs_finished_when_done
                CHECK ((status = 'running') = (finished_at IS NULL))
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX research_runs_one_running ON research_runs (user_id) "
        "WHERE status = 'running'"
    )
    op.execute(
        "CREATE INDEX research_runs_user_started ON research_runs (user_id, started_at DESC)"
    )
    op.execute(
        f"""
        CREATE TABLE research_ratings (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            run_id          uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
            user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            agent_id        uuid NOT NULL,
            instrument_id   uuid NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
            symbol          text NOT NULL,
            status          text NOT NULL CHECK (status IN ({_sql_list(RATING_STATUSES)})),
            rating          text CHECK (rating IN ({_sql_list(RATINGS)})),
            rationale       text,
            findings        jsonb NOT NULL DEFAULT '[]'::jsonb
                            CHECK (jsonb_typeof(findings) = 'array'),
            -- What the model was shown, so a rating's figures can be traced (guideline 7).
            evidence        jsonb NOT NULL DEFAULT '{{}}'::jsonb
                            CHECK (jsonb_typeof(evidence) = 'object'),
            problems        jsonb NOT NULL DEFAULT '[]'::jsonb
                            CHECK (jsonb_typeof(problems) = 'array'),
            model           text,
            created_at      timestamptz NOT NULL DEFAULT now(),
            FOREIGN KEY (user_id, agent_id) REFERENCES agents(user_id, id) ON DELETE CASCADE,
            CONSTRAINT research_ratings_rated_has_rating
                CHECK ((status = 'rated') = (rating IS NOT NULL AND rationale IS NOT NULL))
        )
        """
    )
    op.execute(
        "CREATE INDEX research_ratings_latest ON research_ratings "
        "(user_id, agent_id, instrument_id, created_at DESC) WHERE status = 'rated'"
    )
    op.execute("CREATE INDEX research_ratings_run ON research_ratings (run_id)")


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM llm_calls WHERE purpose = 'research') THEN
                RAISE EXCEPTION 'llm_calls holds research calls; 0069 cannot describe them';
            END IF;
        END
        $$
        """
    )
    op.execute("DELETE FROM runs WHERE kind = 'research'")
    op.execute("DROP TABLE research_ratings")
    op.execute("DROP TABLE research_runs")
    op.execute(
        "ALTER TABLE user_settings DROP CONSTRAINT user_settings_research_agent_fkey, "
        "DROP COLUMN research_agent_id"
    )
    _kinds(PREVIOUS_KINDS)
    _purposes(PREVIOUS_PURPOSES, PREVIOUS_AGENT_PURPOSES)
