"""The agent limit counts active agents only, and the admin has none (D199-D201).

D72's limit (0047) counted every simulated agent that was not archived. What
costs money is a scan, and only an active agent scans - scheduled or by hand -
so a paused agent is free to keep and the limit now counts **active** ones:

- **Checked** on an insert as active and on any change of state into active:
  paused -> active (a resume) and archived -> active (a restore). An agent
  created paused, a pause, an archive, or any other edit is never refused.
- **Skipped for the admin** (`users.role = 'admin'`): the installation's own
  account is not the one the limit protects the bill from.
- **Serialised as before** by a lock on the user's row, taken before the role
  is read and the count made, so two activations at once cannot both see room
  for one.

The refusal is still a `check_violation` starting `agent_limit_reached`, which
the orchestrator answers as a 409. Agents that are active above a lowered limit
stay active; the next activation is what is refused.

The downgrade restores 0047's function. It checks only writes, so a user with
more live agents than the old rule allowed keeps them.

Revision ID: 0062_active_agent_limit
Revises: 0061_max_decisions
"""

from alembic import op

revision = "0062_active_agent_limit"
down_revision = "0061_max_decisions"
branch_labels = None
depends_on = None

ACTIVE_LIMIT_FUNCTION = """
CREATE OR REPLACE FUNCTION agents_within_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_role text;
    v_limit integer;
    v_count integer;
BEGIN
    IF NEW.is_primary OR NEW.state <> 'active' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.state = 'active' THEN
        RETURN NEW;
    END IF;
    -- One writer per user at a time: the count below is then the truth.
    SELECT role INTO v_role FROM users WHERE id = NEW.user_id FOR UPDATE;
    IF v_role = 'admin' THEN
        RETURN NEW;
    END IF;
    SELECT max_agents_per_user INTO v_limit FROM installation_settings;
    SELECT count(*) INTO v_count
      FROM agents
     WHERE user_id = NEW.user_id
       AND NOT is_primary
       AND state = 'active'
       AND id <> NEW.id;
    IF v_count >= v_limit THEN
        RAISE EXCEPTION 'agent_limit_reached: % of % active agents', v_count, v_limit
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$
"""

#: 0047's function, verbatim.
LIVE_LIMIT_FUNCTION = """
CREATE OR REPLACE FUNCTION agents_within_limit() RETURNS trigger
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


def upgrade() -> None:
    # The trigger (BEFORE INSERT OR UPDATE OF state) already calls this function.
    op.execute(ACTIVE_LIMIT_FUNCTION)


def downgrade() -> None:
    op.execute(LIVE_LIMIT_FUNCTION)
