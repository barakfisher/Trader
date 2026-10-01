"""The universe rescreen as a run: its kind, a heartbeat, and one at a time (M8).

A rescreen rebuilds the universe snapshot from Yahoo's screener - half an hour
or more, as Yahoo rate-limits it (measured 2026-10-01) - so it cannot run inside the
request that starts it. The AI service runs it in the background and finishes
the run row itself (decision 90).

- **`universe_rescreen`**, a run kind, extended the way 0019 extended it:
  `KINDS` is the previous tuple plus this one.
- **`runs.heartbeat_at`**: written every 30 seconds while a background run
  works. A run left `running` used to be reclaimable once it had *started*
  long enough ago (`STALE_RUN_MINUTES`), which was right for work done inside
  a request and wrong for one that legitimately runs for longer: it would
  reclaim a live rescreen and start a second. A run that heartbeats is dead
  only when its heartbeat is stale.
- **At most one running rescreen**, by a partial unique index. The run key
  makes a second click the same day a no-op already; the index also covers a
  rescreen that runs past midnight while the next day's key is claimed.

Revision ID: 0031_universe_rescreen
Revises: 0030_profile_membership
"""

from alembic import op

revision = "0031_universe_rescreen"
down_revision = "0030_profile_membership"
branch_labels = None
depends_on = None

#: The run kinds 0019 left behind.
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
)

#: Kinds after this migration: the previous set plus the rescreen.
KINDS = (*PREVIOUS_KINDS, "universe_rescreen")


def _replace_run_kind_check(kinds: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check")
    op.execute(
        f"ALTER TABLE runs ADD CONSTRAINT runs_kind_check "
        f"CHECK (kind IN ({', '.join(repr(kind) for kind in kinds)}))"
    )


def upgrade() -> None:
    _replace_run_kind_check(KINDS)
    op.execute("ALTER TABLE runs ADD COLUMN heartbeat_at timestamptz")
    op.execute(
        "CREATE UNIQUE INDEX runs_one_running_rescreen ON runs (kind) "
        "WHERE kind = 'universe_rescreen' AND status = 'running'"
    )


def downgrade() -> None:
    op.execute("DROP INDEX runs_one_running_rescreen")
    op.execute("ALTER TABLE runs DROP COLUMN heartbeat_at")
    # A rescreen run is a historical fact; the old constraint cannot describe it.
    op.execute("DELETE FROM runs WHERE kind = 'universe_rescreen'")
    _replace_run_kind_check(PREVIOUS_KINDS)
