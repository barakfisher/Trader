"""`instrument_profiles.membership`: how a profile came to be here (M8).

Until now every profile was a member of the screened universe, because the
loader was the only thing that wrote one. M8 adds a second writer: when a user
names a US equity or ETF the universe lacks, its profile is fetched in the
background (decision 6 of M8's plan), so the instrument is described at once
rather than at the next rescreen.

Such a profile is **not** a member of the universe. The screen's floor exists
so that a topic is answered from instruments large enough to matter, and a
profile fetched because one person holds a small company must not change what
every topic resolves to. So every reader that answers a topic reads `screened`
only, and the gap stays reported until a rescreen admits the listing.

- `screened`: written by the universe loader from a snapshot - every existing row;
- `on_demand`: fetched for one symbol a user named;
- `dropped`: a former member a newer snapshot no longer holds. Written by the
  rescreen (M8 PR 8); rows are kept because holdings reference instruments.

Revision ID: 0030_profile_membership
Revises: 0029_llm_calls
"""

from alembic import op

revision = "0030_profile_membership"
down_revision = "0029_llm_calls"
branch_labels = None
depends_on = None

MEMBERSHIPS = ("screened", "on_demand", "dropped")


def upgrade() -> None:
    values = ", ".join(repr(value) for value in MEMBERSHIPS)
    op.execute(
        f"""
        ALTER TABLE instrument_profiles
            ADD COLUMN membership text NOT NULL DEFAULT 'screened'
                CONSTRAINT instrument_profiles_membership_check CHECK (membership IN ({values}))
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE instrument_profiles DROP COLUMN membership")
