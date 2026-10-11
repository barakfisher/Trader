"""Which findings the user has seen (decision 133, queue task 21).

One column on `user_settings`: `insights_seen_at`. A finding of the main
portfolio is unread while `created_at > insights_seen_at`; the Insights page
counts those in the bar's dot and the All findings tab, and styles them apart.

- **One timestamp, not a flag per observation** (decision 133): no write per row
  read, and no migration each time a new kind of thing becomes readable.
- **Moved by opening All findings or Alerts** (the user, 2026-10-11), to the
  moment the page read its counts - not to the moment of the write - so a
  finding that arrives while the page is open stays unread.
- **Nullable, no default**, as `digest_seen_at` (0046): null is "nothing seen
  yet", and the page bounds unread to the seven days it shows. A default of
  `now()` would silently mark the findings waiting at deploy time as read.
- **Untouched by the settings form**: `replaceUserSettings` names the columns it
  writes; only `markInsightsSeen` moves it, and only forward.

Revision ID: 0050_insights_seen
Revises: 0049_finding_episodes
"""

from alembic import op

revision = "0050_insights_seen"
down_revision = "0049_finding_episodes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE user_settings ADD COLUMN insights_seen_at timestamptz")


def downgrade() -> None:
    op.execute("ALTER TABLE user_settings DROP COLUMN IF EXISTS insights_seen_at")
