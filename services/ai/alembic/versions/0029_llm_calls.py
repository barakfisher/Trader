"""`llm_calls`: one row per model call, written by the provider factory (M8).

Every call a model is asked to make - and every one refused before it was
made, for want of a provider or of budget - is recorded by a wrapper that the
factory puts around whatever provider it builds (decision 87). A call site
cannot forget to log, because it never logs: it only adds its **verdict** on
what came back (`accepted`, or why the text was not used), which only it can
judge.

- `outcome` is what happened on the wire: `ok`, `provider_error`,
  `budget_exhausted`, `no_provider`;
- `verdict` is the call site's judgement of a completion; null until given,
  and forever null for a call that returned nothing to judge;
- cost is in **micro-USD**, the integer unit `pricing.py` already uses:
  cents would round every cheap call to zero (guideline 3 asks for integer
  minor units, and a micro-dollar is one);
- `prompt` and `completion` hold portfolio data, so rows carry `user_id` and
  are deleted after `LLM_CALL_RETENTION_DAYS` - pruned by the insert itself,
  so no job has to remember to.

Revision ID: 0029_llm_calls
Revises: 0028_universe_loads
"""

from alembic import op

revision = "0029_llm_calls"
down_revision = "0028_universe_loads"
branch_labels = None
depends_on = None

AGENTS = ("narration", "ask")
OUTCOMES = ("ok", "provider_error", "budget_exhausted", "no_provider")
VERDICTS = (
    "accepted",
    "malformed",
    "unsourced_figures",
    "empty_completion",
    "degenerate_completion",
)


def _values(values: tuple[str, ...]) -> str:
    return ", ".join(repr(value) for value in values)


def upgrade() -> None:
    op.execute(
        f"""
        CREATE TABLE llm_calls (
            id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id            uuid REFERENCES users (id) ON DELETE CASCADE,
            agent              text NOT NULL
                CONSTRAINT llm_calls_agent_check CHECK (agent IN ({_values(AGENTS)})),
            provider           text NOT NULL,
            model              text,
            outcome            text NOT NULL
                CONSTRAINT llm_calls_outcome_check CHECK (outcome IN ({_values(OUTCOMES)})),
            verdict            text
                CONSTRAINT llm_calls_verdict_check CHECK (verdict IN ({_values(VERDICTS)})),
            error              text,
            latency_ms         integer NOT NULL CHECK (latency_ms >= 0),
            prompt_tokens      integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
            completion_tokens  integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
            cost_micro_usd     bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
            prompt             text NOT NULL,
            completion         text,
            started_at         timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX llm_calls_recent_idx ON llm_calls (started_at DESC)")
    op.execute("CREATE INDEX llm_calls_agent_idx ON llm_calls (agent, started_at DESC)")


def downgrade() -> None:
    op.execute("DROP TABLE llm_calls")
