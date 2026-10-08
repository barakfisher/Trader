"""Scheduled agent scans as runs: the ask and each attempt (D68-D74).

Stage 4, PR 7b (docs/PROPOSAL-MULTI-AGENT.md D68-D74).

Two run kinds, extended the way 0031 extended the list:

- **`agent_scans`** is the 15-minute ask (the local timer or a CronJob). It
  decides which agents' slots are due and puts them on the queue; its own run
  key is the usual 15-minute bucket.
- **`agent_scan`** is one attempt at one agent's slot, run by the queue's
  worker. Its run key names the agent, the New York day, the slot and the
  attempt (`agent_scan:<agent>:<day>:<slot>:<n>`), so a slot's history is a
  prefix query and the runs log shows every try. Its `agent_id` is the agent
  scanned, not the primary.

Revision ID: 0048_agent_scan_runs
Revises: 0047_agent_limit
"""

from alembic import op

revision = "0048_agent_scan_runs"
down_revision = "0047_agent_limit"
branch_labels = None
depends_on = None

#: The run kinds 0031 left behind.
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
)

#: Kinds after this migration.
KINDS = (*PREVIOUS_KINDS, "agent_scans", "agent_scan")


def _replace_run_kind_check(kinds: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check")
    op.execute(
        f"ALTER TABLE runs ADD CONSTRAINT runs_kind_check "
        f"CHECK (kind IN ({', '.join(repr(kind) for kind in kinds)}))"
    )


def upgrade() -> None:
    _replace_run_kind_check(KINDS)


def downgrade() -> None:
    op.execute("DELETE FROM runs WHERE kind IN ('agent_scans', 'agent_scan')")
    _replace_run_kind_check(PREVIOUS_KINDS)
