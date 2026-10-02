"""The language the interface speaks to a user (Hebrew slice 3).

One column on `user_settings`: `'en'` or `'he'`, English by default.

- **On `user_settings`, not `users`.** Migration 0006 drew the line: `users`
  holds what identifies an account and resolves "today" (`timezone`), while
  `user_settings` holds what reaches the user, and how. A language is the
  second kind - and it is the row Telegram and the digest already read, so
  when server-generated text is translated (not in v1, by the user's
  decision of 2026-10-01) it follows this setting without moving it.
- **Not the browser's.** A choice kept in local storage would reach one
  browser and no message; and the interface would flash English on every
  first paint before reading it. It travels with the session instead.
- **A CHECK, not a free string.** A language the interface has no catalogue
  for would render English while claiming to be something else. Adding a
  language is a migration that widens the CHECK, alongside the catalogue it
  needs - the same pair of edits, in one PR.

The default is written once, here, and materialised into a row by the
orchestrator's `getOrCreateUserSettings`, so no reader restates it.

Revision ID: 0034_user_language
Revises: 0033_app_role
"""

from alembic import op

revision = "0034_user_language"
down_revision = "0033_app_role"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE user_settings
            ADD COLUMN language text NOT NULL DEFAULT 'en'
                CONSTRAINT user_settings_language_is_known CHECK (language IN ('en', 'he'))
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE user_settings DROP COLUMN IF EXISTS language")
