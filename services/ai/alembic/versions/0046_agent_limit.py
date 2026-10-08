"""How many simulated agents a user may have, set on the Admin page (D71).

Stage 4, PR 7a (docs/PROPOSAL-MULTI-AGENT.md D71).

**`installation_settings`** is one row of typed columns, not a key/value
table: a wrong value is refused by a CHECK rather than read back as text and
interpreted somewhere. The single row is the primary key `id = true`, so a
second row cannot exist; the migration writes it, and the app role may update
it but not insert or delete one, so the row the code reads is always there.
`max_agents_per_user` starts at 3, between 1 and 50. Like `llm_model_choices`
it is the installation's, so guideline 5's `user_id` is `updated_by`, the
admin who changed it.

**The database enforces the limit**, on an insert of an agent and on a
restore from the archive, which are the two ways a user gains one. Counted:
simulated agents that are not archived - the primary never counts (it is the
real portfolio, D1), and archiving one frees a place. The count and the write
are serialised by a lock on the user's row, so two creates at once cannot both
see two agents and both make a third: the second waits for the first, then
counts three. The refusal is a `check_violation` whose message starts with
`agent_limit_reached`, which the orchestrator answers as a 409; the
orchestrator also checks first, so the page can say so before anyone types a
name. Lowering the limit below what a user already has refuses nothing that
exists: it stops the next create.

Revision ID: 0046_agent_limit
Revises: 0045_account_reset
"""

from alembic import op

revision = "0046_agent_limit"
down_revision = "0045_account_reset"
branch_labels = None
depends_on = None

APP_ROLE = "traders_app"
#: D71's default and bounds; the orchestrator's admin route reads the same.
DEFAULT_MAX_AGENTS_PER_USER = 3
MAX_AGENTS_PER_USER_CEILING = 50


def upgrade() -> None:
    op.execute(
        f"""
        CREATE TABLE installation_settings (
            id boolean PRIMARY KEY DEFAULT true CHECK (id),
            max_agents_per_user integer NOT NULL
                DEFAULT {DEFAULT_MAX_AGENTS_PER_USER}
                CHECK (max_agents_per_user BETWEEN 1 AND {MAX_AGENTS_PER_USER_CEILING}),
            updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
            updated_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("INSERT INTO installation_settings (id) VALUES (true)")
    # 0033's default privileges granted the app role everything on a new table.
    op.execute(f"REVOKE INSERT, DELETE, TRUNCATE ON installation_settings FROM {APP_ROLE}")

    op.execute(
        """
        CREATE FUNCTION agents_within_limit() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE
            v_limit integer;
            v_count integer;
        BEGIN
            IF NEW.is_primary OR NEW.state = 'archived' THEN
                RETURN NEW;
            END IF;
            IF TG_OP = 'UPDATE' AND OLD.state <> 'archived' THEN
                RETURN NEW;
            END IF;
            -- One writer per user at a time: the count below is then the truth.
            PERFORM 1 FROM users WHERE id = NEW.user_id FOR UPDATE;
            SELECT max_agents_per_user INTO v_limit FROM installation_settings;
            SELECT count(*) INTO v_count
              FROM agents
             WHERE user_id = NEW.user_id
               AND NOT is_primary
               AND state <> 'archived'
               AND id <> NEW.id;
            IF v_count >= v_limit THEN
                RAISE EXCEPTION 'agent_limit_reached: % of % agents', v_count, v_limit
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER agents_within_limit
        BEFORE INSERT OR UPDATE OF state ON agents
        FOR EACH ROW EXECUTE FUNCTION agents_within_limit()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER agents_within_limit ON agents")
    op.execute("DROP FUNCTION agents_within_limit()")
    op.execute("DROP TABLE installation_settings")
