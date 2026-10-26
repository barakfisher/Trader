"""Sign-in through Google or GitHub: `user_identities` (D262, D263).

One row per provider account linked to a Traders account: the provider, the
provider's stable subject id (never the email, which a person can change at
the provider), the user, and the address the provider reported when it was
linked. Unique on (provider, subject), so one Google account signs in to one
Traders account; a user may link one account per provider.

`users.password_hash` is already nullable (0058), so an account that only
signs in through a provider fits `users` unchanged.

Revision ID: 0075_user_identities
Revises: 0074_email_verification
"""

from alembic import op

revision = "0075_user_identities"
down_revision = "0074_email_verification"
branch_labels = None
depends_on = None

#: `apps/orchestrator/src/auth/oauth.ts` `OAUTH_PROVIDERS`.
PROVIDERS = ("google", "github")


def upgrade() -> None:
    providers = ", ".join(f"'{name}'" for name in PROVIDERS)
    op.execute(
        f"""
        CREATE TABLE user_identities (
            id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            provider    text NOT NULL CHECK (provider IN ({providers})),
            -- The provider's stable id for the person: Google's `sub`, GitHub's user id.
            subject     text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
            -- What the provider said when the link was made; shown in Settings.
            email       text CHECK (char_length(email) <= 320),
            created_at  timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT user_identities_provider_subject UNIQUE (provider, subject),
            CONSTRAINT user_identities_one_per_provider UNIQUE (user_id, provider)
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE user_identities")
