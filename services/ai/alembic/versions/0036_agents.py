"""Agents, and `agent_id` on every portfolio row (multi-agent Stage 1, PR 1).

`docs/PROPOSAL-MULTI-AGENT.md` §3 and §12. A user will own several portfolios:
the real one, which is the **primary agent** ("Main portfolio"), and simulated
ones. This revision creates the `agents` table, gives every user their primary,
and records on every portfolio row which agent owns it. Nothing a user sees
changes: every existing row belongs to the primary.

- **`agent_id` is NOT NULL, and has no default.** A nullable discriminator is
  one forgotten `WHERE agent_id IS NULL` away from presenting simulated holdings
  as real; a default of "the primary" is the same trap in another form, because
  a writer that forgot the column would silently write to the real portfolio.
  Without a default, forgetting it is an error at the INSERT.
- **One exception: `runs`.** Its `user_id` is already nullable, because the
  universe rescreen is the installation's work rather than an account's, and an
  installation has no primary. `runs.agent_id` follows `runs.user_id` exactly
  (`runs_agent_follows_user`): null means "no account", never "real".
- **A composite foreign key `(user_id, agent_id)`** against `agents (user_id,
  id)`, so a row can never name another user's agent. `user_id` stays on every
  table (guideline 5).
- **Expand, not yet contract.** The per-agent unique indexes are added *beside*
  the per-user ones, which stay until the next revision. Every `ON CONFLICT` in
  the orchestrator names a per-user constraint today; dropping them here would
  break each of those inserts at runtime in the window between this migration
  and the code that names the new ones.
- **The primary is passive and real** (decision D1): no budget, no persona, and
  always active - pausing the real portfolio means nothing. Enforced by
  `agents_primary_is_real`, so it survives a bug in the application.
- **Every user gets a primary by trigger**, not by remembering. Users are
  created by migration 0001 today and by nothing at runtime, but a test or a
  future sign-up that inserts a user would otherwise produce an account whose
  every portfolio write fails.
- **`philosophy`, `domain`, `scan_cadence`, `thresholds`** from §3.1 are not
  here: decisions D14 and D16 drop the first, and the others arrive with the
  stage that reads them.

The downgrade refuses while a non-primary agent exists: removing `agent_id`
would fold a simulated portfolio's rows into the real one.

Revision ID: 0036_agents
Revises: 0035_observation_localized
"""

from alembic import op

revision = "0036_agents"
down_revision = "0035_observation_localized"
branch_labels = None
depends_on = None

#: Every table whose rows belong to an agent. `runs` is the nullable exception.
OWNED_TABLES = (
    "holdings",
    "observations",
    "proposals",
    "intents",
    "runs",
    "portfolio_snapshots",
    "target_weights",
    "notifications",
    "proposal_episodes",
)

#: The per-agent unique indexes, beside the per-user constraints they replace
#: in the next revision. `runs` treats nulls as equal so the installation's
#: rescreen keys stay unique among themselves.
AGENT_UNIQUE_INDEXES = {
    "holdings_agent_instrument_key": "holdings (agent_id, instrument_id)",
    "observations_agent_dedupe_key": "observations (agent_id, dedupe_key)",
    "runs_agent_run_key": "runs (agent_id, run_key) NULLS NOT DISTINCT",
    "portfolio_snapshots_agent_as_of_key": "portfolio_snapshots (agent_id, as_of)",
    "target_weights_agent_instrument_key": "target_weights (agent_id, instrument_id)",
    "proposal_episodes_agent_one_open": (
        "proposal_episodes (agent_id, observation_kind, subject_ref) WHERE closed_at IS NULL"
    ),
}


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE agents (
            id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            slug         text NOT NULL,
            name         text NOT NULL,
            persona      text,
            is_primary   boolean NOT NULL DEFAULT false,
            budget_minor bigint,
            currency     text NOT NULL DEFAULT 'USD',
            state        text NOT NULL DEFAULT 'active'
                         CHECK (state IN ('active', 'paused', 'archived')),
            created_at   timestamptz NOT NULL DEFAULT now(),
            UNIQUE (user_id, slug),
            UNIQUE (user_id, name),
            -- The target of every owned table's composite foreign key.
            UNIQUE (user_id, id),
            CONSTRAINT agents_primary_is_real CHECK (
                NOT is_primary
                OR (budget_minor IS NULL AND persona IS NULL AND state = 'active')
            )
        )
        """
    )
    op.execute("CREATE UNIQUE INDEX agents_one_primary_idx ON agents (user_id) WHERE is_primary")

    op.execute(
        """
        CREATE FUNCTION agents_seed_primary() RETURNS trigger
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
    op.execute(
        """
        INSERT INTO agents (user_id, slug, name, is_primary)
        SELECT id, 'primary-portfolio', 'Main portfolio', true FROM users
        """
    )

    for table in OWNED_TABLES:
        op.execute(f"ALTER TABLE {table} ADD COLUMN agent_id uuid")
        op.execute(
            f"""
            UPDATE {table} AS t
               SET agent_id = a.id
              FROM agents AS a
             WHERE a.user_id = t.user_id AND a.is_primary
            """
        )
        if table != "runs":
            op.execute(f"ALTER TABLE {table} ALTER COLUMN agent_id SET NOT NULL")
        op.execute(
            f"""
            ALTER TABLE {table}
              ADD CONSTRAINT {table}_agent_fkey
              FOREIGN KEY (user_id, agent_id) REFERENCES agents (user_id, id)
            """
        )
    op.execute(
        """
        ALTER TABLE runs
          ADD CONSTRAINT runs_agent_follows_user
          CHECK ((user_id IS NULL) = (agent_id IS NULL))
        """
    )

    for name, definition in AGENT_UNIQUE_INDEXES.items():
        table, _, columns = definition.partition(" ")
        op.execute(f"CREATE UNIQUE INDEX {name} ON {table} {columns}")


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM agents WHERE NOT is_primary) THEN
                RAISE EXCEPTION 'agents holds non-primary agents; downgrading would fold '
                    'their rows into the real portfolio. To discard them deliberately: '
                    'DELETE FROM agents WHERE NOT is_primary';
            END IF;
        END;
        $$
        """
    )
    for name in AGENT_UNIQUE_INDEXES:
        op.execute(f"DROP INDEX {name}")
    op.execute("ALTER TABLE runs DROP CONSTRAINT runs_agent_follows_user")
    for table in OWNED_TABLES:
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT {table}_agent_fkey")
        op.execute(f"ALTER TABLE {table} DROP COLUMN agent_id")
    op.execute("DROP TRIGGER users_seed_primary_agent ON users")
    op.execute("DROP FUNCTION agents_seed_primary()")
    op.execute("DROP TABLE agents")
