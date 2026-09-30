"""`ops_events`: gaps between what users ask for and what the universe holds (M8).

Two kinds, both reported on the admin page:

- `universe_gap_missing_ticker` - a symbol a user named (adding a holding,
  previewing an import, adding a ticker to a topic) that the universe does not
  hold, or that nothing could price. The detail says which rule of the screen
  keeps it out, or that none does - the real gap only a rescreen can close;
- `universe_gap_low_confidence` - a topic a user asked about whose every
  candidate fell below the resolver's gate. The detail carries the gate and the
  best score, so "is the gate in the right place?" can be asked of real
  questions rather than argued.

Narration rejections are not here: `observations.fallback_reason` already
records them, and a second log of the same fact would drift from the first.

**One row per thing per day, counted.** `dedupe_key` is unique and a repeat
bumps `occurrences` and `last_seen_at` instead of inserting (guideline 8): an
import previewed five times is one gap seen five times, not five gaps. Events
from a user's own words carry `user_id` (guideline 5) and go with the user.

Revision ID: 0027_ops_events
Revises: 0026_admin_audit
"""

from alembic import op

revision = "0027_ops_events"
down_revision = "0026_admin_audit"
branch_labels = None
depends_on = None

#: Not `KINDS`: that name marks a migration of `runs_kind_check`
#: (`tests/test_run_kinds_contract.py`), which this is not.
EVENT_KINDS = ("universe_gap_missing_ticker", "universe_gap_low_confidence")


def upgrade() -> None:
    kinds = ", ".join(repr(kind) for kind in EVENT_KINDS)
    op.execute(
        f"""
        CREATE TABLE ops_events (
            id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            kind          text NOT NULL CONSTRAINT ops_events_kind_check CHECK (kind IN ({kinds})),
            user_id       uuid REFERENCES users (id) ON DELETE CASCADE,
            detail        jsonb NOT NULL DEFAULT '{{}}'::jsonb,
            dedupe_key    text NOT NULL UNIQUE,
            occurrences   integer NOT NULL DEFAULT 1 CHECK (occurrences > 0),
            occurred_at   timestamptz NOT NULL DEFAULT now(),
            last_seen_at  timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX ops_events_recent_idx ON ops_events (kind, last_seen_at DESC)")


def downgrade() -> None:
    op.execute("DROP TABLE ops_events")
