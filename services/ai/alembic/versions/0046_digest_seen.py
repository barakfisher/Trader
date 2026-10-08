"""Which daily digest the user has seen (UX4).

One column on `user_settings`: `digest_seen_at`, the send time of the last
digest the user opened or dismissed. The dashboard announces a digest with a
banner until then.

- **A time, not an id.** A digest is not stored as a message: it is the batch
  of digest-channel `notifications` rows one run settled as `sent`, named by
  the latest `sent_at` among them (`listLastDigestEntries`). That send time is
  the only identity a digest has, so it is what "seen" records.
- **On the server, not in the browser.** A dismissal kept in local storage
  would come back on the phone - the banner would announce a digest already
  read on the laptop. It is per user, like every setting on this row.
- **Nullable, no default.** Null is "no digest seen yet"; any digest sent is
  newer than that. A default of `now()` would silently mark the digest that
  is waiting at deploy time as read.
- **Untouched by the settings form.** `replaceUserSettings` names the columns
  it writes, so saving settings cannot clear it; only the orchestrator's
  `markDigestSeen` moves it, and only forward (`GREATEST`).

Revision ID: 0046_digest_seen
Revises: 0045_account_reset
"""

from alembic import op

revision = "0046_digest_seen"
down_revision = "0045_account_reset"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE user_settings ADD COLUMN digest_seen_at timestamptz")


def downgrade() -> None:
    op.execute("ALTER TABLE user_settings DROP COLUMN IF EXISTS digest_seen_at")
