"""Which version of the privacy policy and terms each user accepted, and when (D265).

- **`legal_acceptances`**: one row per user and version, written when sign-up
  ticks the box or when a signed-in user accepts a new version. The version is
  the publication date `packages/shared` `LEGAL_VERSION` names; a user may
  hold several rows, one per version they agreed to, which is the history a
  dispute would ask for.
- **Append-only for the app's role**: it may insert and read, never change or
  delete a record of what someone agreed to. The rows go with the user by
  cascade, so the erase (0076) and an unverified request's removal take them
  without a grant.

Revision ID: 0077_legal_acceptances
Revises: 0076_account_deletion
"""

from alembic import op

revision = "0077_legal_acceptances"
down_revision = "0076_account_deletion"
branch_labels = None
depends_on = None

APP_ROLE = "traders_app"

#: `packages/shared` `LEGAL_VERSION_PATTERN`: the date the text was published.
VERSION_PATTERN = r"^\d{4}-\d{2}-\d{2}$"


def upgrade() -> None:
    op.execute(
        f"""
        CREATE TABLE legal_acceptances (
            user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            version      text NOT NULL CHECK (version ~ '{VERSION_PATTERN}'),
            accepted_at  timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (user_id, version)
        )
        """
    )
    op.execute(f"REVOKE UPDATE, DELETE, TRUNCATE ON legal_acceptances FROM {APP_ROLE}")


def downgrade() -> None:
    op.execute("DROP TABLE legal_acceptances")
