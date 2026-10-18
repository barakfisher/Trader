"""Accounts for several users: status, password, session version, spend cap (M9, D155-D163).

M9's schema, and nothing reads it yet: login, the approval flow, the cap's
enforcement and the scheduler's fan-out are the PRs after this one. Deployed
alone it changes nothing a user sees - the seeded admin becomes `active` and
signs in exactly as before.

**`users` gains:**
- `status` - `pending` (signed up, waiting for the admin, D156), `active`,
  `rejected` (kept, so the same email cannot ask again, D156) or `disabled`
  (the reversible removal, D160). **The default is `pending`**: a code path
  that forgets the status makes a user with no access and no agent, the
  direction that fails safe.
- `password_hash` (D159) - NULL until one is set; a user without one cannot
  sign in with a password. `password_must_change` - the admin's one-time
  password (D162), changed at the next sign-in.
- `session_version` (D160) - copied into the session cookie; bumping it ends
  every session the user holds.
- `llm_cap_micro_usd` (D157) - the monthly LLM spend cap, integer micro-USD
  like `agents.llm_budget_micro_usd`. NULL is uncapped, which only the admin
  may be: **an active non-admin without a cap is refused by a CHECK**, so
  "strict" does not rest on the app remembering. Demoting an admin therefore
  needs a cap in the same statement.
- `approved_at`, `approved_by` - who let the user in; `last_sign_in_at` - for
  the admin's user list (D162).

**Email is unique regardless of case** - `Dana@x.com` and `dana@x.com` are one
account and one pending request (D156's "one per email"). It stays nullable:
signup always writes one, and a user without one cannot sign in with a
password. A CHECK requiring it would have to invent addresses for the users
that exist without one (the seeded admin until the bootstrap script runs).

**The primary agent arrives with activation, not with the row** (D156). The
0036 trigger fired on every insert; now one fires on an insert that is already
`active` and one on the change to `active`. `ON CONFLICT` on the one-primary
index makes re-enabling a disabled user a no-op rather than a second primary.

**`installation_settings` gains** the default cap an approval offers ($10,
D157) and the most pending requests at once (D156; 0 closes signup).

**Existing users become `active`**, which they were in every sense; an
existing non-admin gets the default cap so the CHECK holds (production has
none - the migration round trip does).

**The downgrade refuses while any user is not `active`**: the older schema has
no status, so a disabled or rejected user would silently become an ordinary
one. Activating them - with a zero cap where they have none, so the CHECK holds
and they can spend nothing - is the deliberate act that lets it proceed.

Revision ID: 0058_user_accounts
Revises: 0057_agent_mandate
"""

from alembic import op

revision = "0058_user_accounts"
down_revision = "0057_agent_mandate"
branch_labels = None
depends_on = None

#: D157's default monthly cap, $10, and the most an admin may set as a default.
DEFAULT_LLM_CAP_MICRO_USD = 10_000_000
LLM_CAP_CEILING_MICRO_USD = 1_000_000_000
#: D156's limit on pending requests at once; 0 closes signup.
DEFAULT_MAX_PENDING_SIGNUPS = 5
MAX_PENDING_SIGNUPS_CEILING = 50

USER_STATUSES = ("pending", "active", "rejected", "disabled")


def upgrade() -> None:
    statuses = ", ".join(f"'{status}'" for status in USER_STATUSES)
    op.execute(
        f"""
        ALTER TABLE users
          ADD COLUMN status text NOT NULL DEFAULT 'active'
              CONSTRAINT users_status_check CHECK (status IN ({statuses})),
          ADD COLUMN password_hash text,
          ADD COLUMN password_must_change boolean NOT NULL DEFAULT false,
          ADD COLUMN session_version integer NOT NULL DEFAULT 1
              CONSTRAINT users_session_version_check CHECK (session_version >= 1),
          ADD COLUMN llm_cap_micro_usd bigint
              CONSTRAINT users_llm_cap_check CHECK (llm_cap_micro_usd >= 0),
          ADD COLUMN approved_at timestamptz,
          ADD COLUMN approved_by uuid REFERENCES users (id) ON DELETE SET NULL,
          ADD COLUMN last_sign_in_at timestamptz
        """
    )
    # Every existing user was active; the default flips to the safe one after.
    op.execute("ALTER TABLE users ALTER COLUMN status SET DEFAULT 'pending'")
    op.execute(
        f"""
        UPDATE users SET llm_cap_micro_usd = {DEFAULT_LLM_CAP_MICRO_USD}
         WHERE role <> 'admin' AND llm_cap_micro_usd IS NULL
        """
    )
    op.execute(
        """
        ALTER TABLE users
          ADD CONSTRAINT users_active_user_has_cap
              CHECK (role = 'admin' OR status <> 'active' OR llm_cap_micro_usd IS NOT NULL)
        """
    )
    op.execute("ALTER TABLE users DROP CONSTRAINT users_email_key")
    op.execute("CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email))")

    op.execute(
        """
        CREATE OR REPLACE FUNCTION agents_seed_primary() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            INSERT INTO agents (user_id, slug, name, is_primary)
            VALUES (NEW.id, 'primary-portfolio', 'Main portfolio', true)
            ON CONFLICT (user_id) WHERE is_primary DO NOTHING;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute("DROP TRIGGER users_seed_primary_agent ON users")
    op.execute(
        """
        CREATE TRIGGER users_seed_primary_agent
            AFTER INSERT ON users
            FOR EACH ROW WHEN (NEW.status = 'active')
            EXECUTE FUNCTION agents_seed_primary()
        """
    )
    op.execute(
        """
        CREATE TRIGGER users_activate_primary_agent
            AFTER UPDATE OF status ON users
            FOR EACH ROW WHEN (NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active')
            EXECUTE FUNCTION agents_seed_primary()
        """
    )

    op.execute(
        f"""
        ALTER TABLE installation_settings
          ADD COLUMN default_llm_cap_micro_usd bigint NOT NULL
              DEFAULT {DEFAULT_LLM_CAP_MICRO_USD}
              CHECK (default_llm_cap_micro_usd BETWEEN 0 AND {LLM_CAP_CEILING_MICRO_USD}),
          ADD COLUMN max_pending_signups integer NOT NULL
              DEFAULT {DEFAULT_MAX_PENDING_SIGNUPS}
              CHECK (max_pending_signups BETWEEN 0 AND {MAX_PENDING_SIGNUPS_CEILING})
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM users WHERE status <> 'active') THEN
                RAISE EXCEPTION 'users holds users who are not active; downgrading would make '
                    'them ordinary users. To let them in deliberately: '
                    'UPDATE users SET status = ''active'', '
                    'llm_cap_micro_usd = coalesce(llm_cap_micro_usd, 0) WHERE status <> ''active''';
            END IF;
        END;
        $$
        """
    )
    op.execute(
        """
        ALTER TABLE installation_settings
          DROP COLUMN max_pending_signups,
          DROP COLUMN default_llm_cap_micro_usd
        """
    )

    op.execute("DROP TRIGGER users_activate_primary_agent ON users")
    op.execute("DROP TRIGGER users_seed_primary_agent ON users")
    op.execute(
        """
        CREATE OR REPLACE FUNCTION agents_seed_primary() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            INSERT INTO agents (user_id, slug, name, is_primary)
            VALUES (NEW.id, 'primary-portfolio', 'Main portfolio', true);
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER users_seed_primary_agent
            AFTER INSERT ON users
            FOR EACH ROW EXECUTE FUNCTION agents_seed_primary()
        """
    )

    op.execute("DROP INDEX users_email_lower_key")
    op.execute("ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email)")
    op.execute(
        """
        ALTER TABLE users
          DROP CONSTRAINT users_active_user_has_cap,
          DROP COLUMN last_sign_in_at,
          DROP COLUMN approved_by,
          DROP COLUMN approved_at,
          DROP COLUMN llm_cap_micro_usd,
          DROP COLUMN session_version,
          DROP COLUMN password_must_change,
          DROP COLUMN password_hash,
          DROP COLUMN status
        """
    )
