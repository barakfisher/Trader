"""A user keeps at most 50 simulated agents that are not archived (D202).

D199 (0062) let paused agents go uncounted, since they cannot spend. With
signup live, that would let a user create paused agents without end - rows, a
card each on the Agents page, a line each in the consolidated view. This is the
backstop: **`MAX_AGENTS_PER_USER_CEILING`**, a fixed number rather than a
setting, the same 50 that bounds the Admin page's limit.

- **Checked** when an agent joins the set that is not archived: an insert in
  any state but `archived`, and a restore (archived -> paused or active). A
  pause, a resume, an archive or any other edit is never refused by it.
- **Skipped for the admin**, as 0062's limit is (D201).
- **Serialised** by the same lock on the user's row that 0062's function takes,
  so two creates at once cannot both see room for the fiftieth.

A trigger of its own beside `agents_within_limit`, not a third version of that
function: the two rules count different sets and are refused with different
codes. The refusal is a `check_violation` starting `agent_total_reached`, which
the orchestrator answers as a 409. A user already past it (none is, 2026-10-20)
keeps every agent; the next create or restore is refused.

Revision ID: 0063_agent_total_ceiling
Revises: 0062_active_agent_limit
"""

from alembic import op

revision = "0063_agent_total_ceiling"
down_revision = "0062_active_agent_limit"
branch_labels = None
depends_on = None

#: `MAX_AGENTS_PER_USER_CEILING` in `packages/shared/src/types.ts` (D72, D202).
MAX_AGENTS_IN_TOTAL = 50


def upgrade() -> None:
    op.execute(
        f"""
        CREATE FUNCTION agents_within_total() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE
            v_role text;
            v_count integer;
        BEGIN
            IF NEW.is_primary OR NEW.state = 'archived' THEN
                RETURN NEW;
            END IF;
            -- Only a create or a restore joins the set that is not archived.
            IF TG_OP = 'UPDATE' AND OLD.state <> 'archived' THEN
                RETURN NEW;
            END IF;
            -- One writer per user at a time: the count below is then the truth.
            SELECT role INTO v_role FROM users WHERE id = NEW.user_id FOR UPDATE;
            IF v_role = 'admin' THEN
                RETURN NEW;
            END IF;
            SELECT count(*) INTO v_count
              FROM agents
             WHERE user_id = NEW.user_id
               AND NOT is_primary
               AND state <> 'archived'
               AND id <> NEW.id;
            IF v_count >= {MAX_AGENTS_IN_TOTAL} THEN
                RAISE EXCEPTION 'agent_total_reached: % of % agents',
                    v_count, {MAX_AGENTS_IN_TOTAL}
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER agents_within_total
        BEFORE INSERT OR UPDATE OF state ON agents
        FOR EACH ROW EXECUTE FUNCTION agents_within_total()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER agents_within_total ON agents")
    op.execute("DROP FUNCTION agents_within_total()")
