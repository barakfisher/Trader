"""GitHub is no longer a sign-in provider: `user_identities.provider` is Google only (D376).

0075 allowed `('google', 'github')`. GitHub's OAuth app was never registered on
production, and measured 2026-11-03 neither installation holds a GitHub
identity (production: two Google rows; compose: none). The code no longer
offers GitHub, so the CHECK follows it: a write naming GitHub fails here
instead of leaving a row nothing reads.

The upgrade refuses, rather than deletes, if a GitHub row exists: for an
account without a password that row may be its only way in, and deleting it
would lock the person out without a word.

Downgrade restores 0075's CHECK; no row changes either way.

Revision ID: 0083_drop_github_identities
Revises: 0082_remove_topics
"""

from alembic import op

revision = "0083_drop_github_identities"
down_revision = "0082_remove_topics"
branch_labels = None
depends_on = None

#: `packages/shared` `OAUTH_PROVIDERS`.
PROVIDERS = ("google",)
#: 0075's list, restored by the downgrade.
PREVIOUS_PROVIDERS = ("google", "github")


def _check(providers: tuple[str, ...]) -> str:
    values = ", ".join(f"'{name}'" for name in providers)
    return (
        "ALTER TABLE user_identities ADD CONSTRAINT user_identities_provider_check "
        f"CHECK (provider IN ({values}))"
    )


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM user_identities WHERE provider = 'github') THEN
                RAISE EXCEPTION
                    'user_identities holds GitHub identities; one may be an account''s only way in';
            END IF;
        END $$
        """
    )
    op.execute("ALTER TABLE user_identities DROP CONSTRAINT user_identities_provider_check")
    op.execute(_check(PROVIDERS))


def downgrade() -> None:
    op.execute("ALTER TABLE user_identities DROP CONSTRAINT user_identities_provider_check")
    op.execute(_check(PREVIOUS_PROVIDERS))
