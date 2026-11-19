"""`listed`: a member the daily new-listings screen admitted between rescreens.

Measured 2026-11-19 on production: the universe was a snapshot of 2026-09-24,
the next rescreen fell due on 2026-12-24, and Anthropic listed (ANT) that day
with no way in before then. The screen alone, run that day, found 189 listings
since the snapshot that pass its rule - about three a day.

A daily run admits them, by the same rule (D39), as `listed`:

- **a member**, like `screened`: a topic is answered from it and an agent may
  trade it;
- **not the startup loader's to drop.** Every deploy reloads the newest
  snapshot, which is older than the listing, and drops every `screened` member
  that snapshot lacks. A listing admitted as `screened` would vanish at the next
  deploy. A snapshot may drop a `listed` profile only when it was taken after
  the listing (`size_as_of`), and a snapshot that holds it makes it `screened`.

- **`runs.kind`** gains `new_listings`, the daily run.

Downgrade turns `listed` profiles into `on_demand` ones - described, no longer
members, as they would be if a user had named them - and deletes the runs of
the new kind, which are bookkeeping.

Revision ID: 0088_listed_membership
Revises: 0087_open_approval
"""

from alembic import op

revision = "0088_listed_membership"
down_revision = "0087_open_approval"
branch_labels = None
depends_on = None

PREVIOUS_MEMBERSHIPS = ("screened", "on_demand", "dropped")
MEMBERSHIPS = (*PREVIOUS_MEMBERSHIPS, "listed")

#: The run kinds before this migration (last changed by 0087).
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
    "research",
    "session_sweep",
    "auth_sweep",
    "account_erase",
    "open_approvals",
)
KINDS = (*PREVIOUS_KINDS, "new_listings")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _memberships(values: tuple[str, ...]) -> None:
    op.execute(
        "ALTER TABLE instrument_profiles DROP CONSTRAINT instrument_profiles_membership_check"
    )
    op.execute(
        "ALTER TABLE instrument_profiles ADD CONSTRAINT instrument_profiles_membership_check "
        f"CHECK (membership IN ({_sql_list(values)}))"
    )


def _kinds(values: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check")
    op.execute(
        f"ALTER TABLE runs ADD CONSTRAINT runs_kind_check CHECK (kind IN ({_sql_list(values)}))"
    )


def upgrade() -> None:
    _memberships(MEMBERSHIPS)
    _kinds(KINDS)


def downgrade() -> None:
    op.execute("DELETE FROM runs WHERE kind = 'new_listings'")
    _kinds(PREVIOUS_KINDS)
    op.execute(
        "UPDATE instrument_profiles SET membership = 'on_demand', updated_at = now() "
        "WHERE membership = 'listed'"
    )
    _memberships(PREVIOUS_MEMBERSHIPS)
