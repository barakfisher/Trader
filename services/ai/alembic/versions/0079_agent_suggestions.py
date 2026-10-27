"""A rule-based review of each simulated agent every N scans (D335-D338).

- **`agent_suggestions`**: what a review found, one row per rule that fired.
  The orchestrator writes it after every N-th counted scan of an agent; the
  figures are the ledger's and the scans' (`evidence`), the change is one
  setting of the `agents` row (`change`: setting, from, to) or none, when the
  rule has nothing concrete to offer and only reports.
- **Idempotent**: `dedupe_key` is the window's last scan and the rule, unique
  per agent, so a review that runs twice for the same window writes once. A
  scan id, not a count, so a reset that erases the scans cannot collide with
  an old window.
- **Status**: `open` until the user applies or dismisses it; `superseded` when
  a later window's review of the same rule replaces it; `stale` when Apply
  found the setting already changed. `decided_at` is set with every status but
  `open`.
- The rows go with the agent and with the user by cascade, so the erase (0076)
  takes them without a change.

Revision ID: 0079_agent_suggestions
Revises: 0078_primary_ledger
"""

from alembic import op

revision = "0079_agent_suggestions"
down_revision = "0078_primary_ledger"
branch_labels = None
depends_on = None

#: `apps/orchestrator/src/services/agentReview.ts` `REVIEW_RULES`.
RULES = ("idle_cash", "fee_drag", "benchmark_lag")
#: `packages/shared` `AGENT_SUGGESTION_STATUSES`.
STATUSES = ("open", "applied", "dismissed", "superseded", "stale")


def _in(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    op.execute(
        f"""
        CREATE TABLE agent_suggestions (
            id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            agent_id    uuid NOT NULL,
            rule        text NOT NULL CHECK (rule IN ({_in(RULES)})),
            dedupe_key  text NOT NULL CHECK (length(dedupe_key) <= 200),
            evidence    jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
            change      jsonb CHECK (change IS NULL OR jsonb_typeof(change) = 'object'),
            status      text NOT NULL DEFAULT 'open' CHECK (status IN ({_in(STATUSES)})),
            created_at  timestamptz NOT NULL DEFAULT now(),
            decided_at  timestamptz,
            CONSTRAINT agent_suggestions_agent_fkey FOREIGN KEY (user_id, agent_id)
                REFERENCES agents(user_id, id) ON DELETE CASCADE,
            CONSTRAINT agent_suggestions_one_per_window UNIQUE (agent_id, dedupe_key),
            CONSTRAINT agent_suggestions_decided_when_closed
                CHECK ((status = 'open') = (decided_at IS NULL))
        )
        """
    )
    op.execute(
        "CREATE INDEX agent_suggestions_open_idx ON agent_suggestions (agent_id, created_at DESC) "
        "WHERE status = 'open'"
    )


def downgrade() -> None:
    op.execute("DROP TABLE agent_suggestions")
