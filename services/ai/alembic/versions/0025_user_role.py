"""Users carry a role: `user` or `admin` (M8).

M8 adds an admin surface - universe status, gap events, LLM observability, the
rescreen button - that an ordinary account must not reach. The orchestrator's
`/admin/*` guard reads this column on every request rather than trusting
anything the session cookie says: the cookie carries only the user id, and a
role copied into it would outlive a demotion until the cookie expired
(decision 83).

The seeded v1 account is the installation's operator, so it becomes `admin`.
Every other row, and every row inserted later, is `user` unless someone says
otherwise.

Revision ID: 0025_user_role
Revises: 0024_topic_proposal_band
"""

from alembic import op

revision = "0025_user_role"
down_revision = "0024_topic_proposal_band"
branch_labels = None
depends_on = None

ROLES = ("user", "admin")
SEED_USER_ID = "00000000-0000-0000-0000-000000000001"


def upgrade() -> None:
    roles = ", ".join(repr(role) for role in ROLES)
    op.execute(
        f"""
        ALTER TABLE users
            ADD COLUMN role text NOT NULL DEFAULT 'user'
                CONSTRAINT users_role_check CHECK (role IN ({roles}))
        """
    )
    op.execute(f"UPDATE users SET role = 'admin' WHERE id = '{SEED_USER_ID}'")


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN role")
