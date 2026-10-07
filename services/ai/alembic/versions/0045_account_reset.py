"""Reset account, by group: the one sanctioned exception to the append-only ledger (task 18).

The user unticks what to keep and erases the rest, group by group:

- **`main_portfolio`** - the primary agent's holdings, target weights, daily
  values, its observations on instruments and the portfolio, their proposals
  with every transition, attempt, episode and intent, the notifications about
  them, and narration's history.
- **`agents_trading`** - every simulated agent's fills, cash movements, holdings,
  daily values, scans, its observations and proposals and their notifications.
  Its cash **and its budget** go to $0 (decided with the user): the agent keeps
  its name, persona, schedule and LLM budget, and waits for *Add cash*.
- **`followed_topics`** - topics, their instruments, and topic observations with
  their notifications.

**Always kept:** settings, Telegram, the agents' configuration, market data, the
universe, and the bookkeeping that is not the account - `runs` (the idempotency
keys: erased, today's digest would be sent again), `llm_calls` (money already
spent), `ops_events` and `admin_audit`.

**One function, `reset_account(user_id, groups)`, and nothing else.** Every
service connects as `traders_app`, which may not delete a fill or a cash
movement at all (0040). The function is `SECURITY DEFINER`: it runs as the owner
and is the only thing `traders_app` may call to erase the ledger. Inside, it sets
the transaction-local `traders.account_reset`, which the two append-only
triggers now accept for a DELETE; the flag alone is worth nothing to
`traders_app`, which still holds no DELETE privilege on either table. UPDATE and
TRUNCATE stay refused for everyone.

**The backup is `account_resets`**, one row per reset holding every erased row
as JSON, per table, written by the same function in the same transaction: the
reset and its backup both happen or neither does. The app role may read it and
nothing more. Restoring is by hand for now.

**A budget of $0.** `agents_simulated_has_budget` asked for more than $0; a reset
agent has exactly $0, so it now asks for at least $0. Creating or editing an
agent at $0 is still refused - by the API, and by `cash_movements_sign`, since
an opening deposit must be positive. **After a reset an agent has no opening
deposit**, and `agents_ledger_follows_budget` used to *update* that row when the
budget changed before the first fill - which would have updated nothing, and
left *Add cash* silently moving no cash. It now inserts the opening deposit when
there is none.

The downgrade refuses while a backup or an agent at $0 exists: it would discard
the backups, and 0040's budget CHECK cannot stand over a $0 agent.

Revision ID: 0045_account_reset
Revises: 0044_trade_proposals
"""

from alembic import op

revision = "0045_account_reset"
down_revision = "0044_trade_proposals"
branch_labels = None
depends_on = None

APP_ROLE = "traders_app"

#: The groups a reset may erase; the orchestrator's list is tested against it.
RESET_GROUPS = ("main_portfolio", "agents_trading", "followed_topics")


def _sql_array(values: tuple[str, ...]) -> str:
    return "ARRAY[" + ", ".join(f"'{value}'" for value in values) + "]::text[]"


def upgrade() -> None:
    op.execute(
        f"""
        CREATE TABLE account_resets (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            groups text[] NOT NULL
                CHECK (cardinality(groups) > 0 AND groups <@ {_sql_array(RESET_GROUPS)}),
            -- Rows erased per table; the backup below holds the rows themselves.
            counts jsonb NOT NULL,
            backup jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX account_resets_user_idx ON account_resets (user_id, created_at DESC)")
    op.execute(f"REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON account_resets FROM {APP_ROLE}")

    # A reset agent has $0; creating one at $0 is still refused (see above).
    op.execute("ALTER TABLE agents DROP CONSTRAINT agents_simulated_has_budget")
    op.execute(
        """
        ALTER TABLE agents ADD CONSTRAINT agents_simulated_has_budget
            CHECK (is_primary OR (budget_minor IS NOT NULL AND budget_minor >= 0))
        """
    )

    # D23, with the reset as its one exception.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION fills_refuse_change() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'DELETE' AND current_setting('traders.account_reset', true) = 'on' THEN
                RETURN OLD;
            END IF;
            RAISE EXCEPTION 'fills are append-only: a recorded trade is corrected by a '
                'counter-trade, never edited (decision D23)'
                USING ERRCODE = 'check_violation';
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION cash_movements_guard() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'TRUNCATE' THEN
                RAISE EXCEPTION 'cash_movements is append-only' USING ERRCODE = 'check_violation';
            END IF;
            IF TG_OP = 'DELETE' AND current_setting('traders.account_reset', true) = 'on' THEN
                RETURN OLD;
            END IF;
            IF OLD.kind = 'opening_deposit'
               AND NOT EXISTS (SELECT 1 FROM fills WHERE agent_id = OLD.agent_id) THEN
                IF TG_OP = 'DELETE' THEN
                    RETURN OLD;
                END IF;
                IF (NEW.id, NEW.user_id, NEW.agent_id, NEW.kind, NEW.currency, NEW.created_at)
                   IS NOT DISTINCT FROM
                   (OLD.id, OLD.user_id, OLD.agent_id, OLD.kind, OLD.currency, OLD.created_at)
                   AND NEW.fill_id IS NULL THEN
                    RETURN NEW;
                END IF;
            END IF;
            RAISE EXCEPTION 'cash_movements is append-only: only the opening deposit of an agent '
                'that has not traded may change (decision D22)'
                USING ERRCODE = 'check_violation';
        END;
        $$
        """
    )

    # D22, and an agent a reset left with no opening deposit.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION agents_ledger_follows_budget() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
        BEGIN
            IF NEW.is_primary THEN
                RETURN NEW;
            END IF;
            IF TG_OP = 'INSERT' THEN
                INSERT INTO agent_cash (agent_id, user_id, balance_minor)
                VALUES (NEW.id, NEW.user_id, 0);
                INSERT INTO cash_movements (user_id, agent_id, kind, amount_minor, created_at)
                VALUES (NEW.user_id, NEW.id, 'opening_deposit', NEW.budget_minor, NEW.created_at);
                RETURN NEW;
            END IF;
            IF NEW.budget_minor IS NOT DISTINCT FROM OLD.budget_minor THEN
                RETURN NEW;
            END IF;
            -- The lock a fill takes, so an edit and a first trade cannot interleave.
            PERFORM 1 FROM agent_cash WHERE agent_id = NEW.id FOR UPDATE;
            IF NOT EXISTS (SELECT 1 FROM fills WHERE agent_id = NEW.id) THEN
                UPDATE cash_movements SET amount_minor = NEW.budget_minor
                 WHERE agent_id = NEW.id AND kind = 'opening_deposit';
                -- A reset erased it: the first deposit after one opens the ledger again.
                IF NOT FOUND AND NEW.budget_minor > 0 THEN
                    INSERT INTO cash_movements (user_id, agent_id, kind, amount_minor)
                    VALUES (NEW.user_id, NEW.id, 'opening_deposit', NEW.budget_minor);
                END IF;
            ELSIF NEW.budget_minor > OLD.budget_minor THEN
                INSERT INTO cash_movements (user_id, agent_id, kind, amount_minor)
                VALUES (NEW.user_id, NEW.id, 'top_up', NEW.budget_minor - OLD.budget_minor);
            ELSE
                RAISE EXCEPTION 'budget_decrease_after_trade: an agent that has traded can have '
                    'its budget raised, not lowered (decision D22)'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )

    # Children before parents, each erased row kept: a cascade would erase rows
    # the backup never saw, so nothing here relies on one.
    op.execute(
        f"""
        CREATE FUNCTION reset_account(p_user_id uuid, p_groups text[])
        RETURNS TABLE (reset_id uuid, counts jsonb)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
        DECLARE
            v_groups text[];
            v_main boolean;
            v_trading boolean;
            v_topics boolean;
            v_primary uuid;
            v_simulated uuid[];
            v_book_agents uuid[];
            v_ledger_agents uuid[];
            v_observations uuid[];
            v_proposals uuid[];
            v_rows jsonb;
            v_backup jsonb := '{{}}'::jsonb;
            v_counts jsonb := '{{}}'::jsonb;
            v_id uuid;
        BEGIN
            v_groups := ARRAY(SELECT DISTINCT g FROM unnest(p_groups) AS g ORDER BY g);
            IF cardinality(v_groups) = 0
               OR NOT v_groups <@ {_sql_array(RESET_GROUPS)}
               OR array_position(v_groups, NULL) IS NOT NULL THEN
                RAISE EXCEPTION 'reset_account: groups must be a non-empty subset of %',
                    {_sql_array(RESET_GROUPS)}
                    USING ERRCODE = 'invalid_parameter_value';
            END IF;
            v_main := 'main_portfolio' = ANY (v_groups);
            v_trading := 'agents_trading' = ANY (v_groups);
            v_topics := 'followed_topics' = ANY (v_groups);

            SELECT id INTO v_primary FROM agents WHERE user_id = p_user_id AND is_primary;
            IF v_primary IS NULL THEN
                RAISE EXCEPTION 'reset_account: user % has no account', p_user_id
                    USING ERRCODE = 'no_data_found';
            END IF;
            SELECT coalesce(array_agg(id ORDER BY id), '{{}}') INTO v_simulated
              FROM agents WHERE user_id = p_user_id AND NOT is_primary;

            v_book_agents := CASE WHEN v_main THEN ARRAY[v_primary] ELSE '{{}}'::uuid[] END
                          || CASE WHEN v_trading THEN v_simulated ELSE '{{}}'::uuid[] END;
            v_ledger_agents := CASE WHEN v_trading THEN v_simulated ELSE '{{}}'::uuid[] END;

            -- The lock a fill takes (D3), so no trade lands while the ledger goes.
            PERFORM 1 FROM agent_cash WHERE agent_id = ANY (v_ledger_agents)
             ORDER BY agent_id FOR UPDATE;

            SELECT coalesce(array_agg(id), '{{}}') INTO v_observations FROM observations
             WHERE user_id = p_user_id
               AND ((v_main AND agent_id = v_primary AND subject_kind <> 'topic')
                 OR (v_trading AND agent_id = ANY (v_simulated))
                 OR (v_topics AND subject_kind = 'topic'));
            SELECT coalesce(array_agg(id), '{{}}') INTO v_proposals FROM proposals
             WHERE user_id = p_user_id
               AND (observation_id = ANY (v_observations) OR agent_id = ANY (v_ledger_agents));

            PERFORM set_config('traders.account_reset', 'on', true);

            WITH gone AS (
                DELETE FROM notifications
                 WHERE user_id = p_user_id
                   AND ((ref_kind = 'observation' AND ref_id = ANY (v_observations))
                     OR (ref_kind = 'proposal' AND ref_id = ANY (v_proposals))
                     OR (v_main AND ref_kind = 'narration'))
                RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('notifications', v_rows);

            -- A fill's movement references it, so movements go first.
            WITH gone AS (
                DELETE FROM cash_movements
                 WHERE user_id = p_user_id AND agent_id = ANY (v_ledger_agents) RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('cash_movements', v_rows);

            WITH gone AS (
                DELETE FROM fills
                 WHERE user_id = p_user_id AND agent_id = ANY (v_ledger_agents) RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('fills', v_rows);

            WITH gone AS (
                DELETE FROM intents WHERE proposal_id = ANY (v_proposals) RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('intents', v_rows);

            WITH gone AS (
                DELETE FROM proposal_attempts WHERE proposal_id = ANY (v_proposals) RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('proposal_attempts', v_rows);

            WITH gone AS (
                DELETE FROM proposal_transitions WHERE proposal_id = ANY (v_proposals) RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('proposal_transitions', v_rows);

            WITH gone AS (
                DELETE FROM proposals WHERE id = ANY (v_proposals) RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('proposals', v_rows);

            WITH gone AS (
                DELETE FROM proposal_episodes
                 WHERE observation_id = ANY (v_observations) RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('proposal_episodes', v_rows);

            WITH gone AS (
                DELETE FROM observations WHERE id = ANY (v_observations) RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('observations', v_rows);

            -- After proposals, which reference the scan that wrote them.
            WITH gone AS (
                DELETE FROM agent_scans
                 WHERE user_id = p_user_id AND agent_id = ANY (v_ledger_agents) RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('agent_scans', v_rows);

            WITH gone AS (
                DELETE FROM holdings
                 WHERE user_id = p_user_id AND agent_id = ANY (v_book_agents) RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('holdings', v_rows);

            WITH gone AS (
                DELETE FROM target_weights
                 WHERE user_id = p_user_id AND agent_id = ANY (v_book_agents) RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('target_weights', v_rows);

            WITH gone AS (
                DELETE FROM portfolio_snapshots
                 WHERE user_id = p_user_id AND agent_id = ANY (v_book_agents) RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('portfolio_snapshots', v_rows);

            WITH gone AS (
                DELETE FROM narration_transitions WHERE v_main AND user_id = p_user_id RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('narration_transitions', v_rows);

            WITH gone AS (
                DELETE FROM topic_instruments WHERE v_topics AND user_id = p_user_id RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('topic_instruments', v_rows);

            WITH gone AS (
                DELETE FROM topics WHERE v_topics AND user_id = p_user_id RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('topics', v_rows);

            -- Cash and budget to $0. Each agent's balance and budget as they were
            -- are kept, so the backup alone says what the reset took.
            SELECT coalesce(jsonb_agg(jsonb_build_object(
                       'agent_id', c.agent_id, 'balance_minor', c.balance_minor,
                       'budget_minor', a.budget_minor)), '[]')
              INTO v_rows
              FROM agent_cash c JOIN agents a ON a.id = c.agent_id
             WHERE c.agent_id = ANY (v_ledger_agents);
            v_backup := v_backup || jsonb_build_object('agent_cash', v_rows);
            UPDATE agent_cash SET balance_minor = 0, updated_at = now()
             WHERE agent_id = ANY (v_ledger_agents);
            UPDATE agents SET budget_minor = 0 WHERE id = ANY (v_ledger_agents);

            PERFORM set_config('traders.account_reset', 'off', true);

            SELECT coalesce(jsonb_object_agg(key, jsonb_array_length(value)), '{{}}')
              INTO v_counts FROM jsonb_each(v_backup);
            INSERT INTO account_resets (user_id, groups, counts, backup)
            VALUES (p_user_id, v_groups, v_counts, v_backup)
            RETURNING id INTO v_id;
            RETURN QUERY SELECT v_id, v_counts;
        END;
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION reset_account(uuid, text[]) FROM PUBLIC")
    op.execute(f"GRANT EXECUTE ON FUNCTION reset_account(uuid, text[]) TO {APP_ROLE}")


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM account_resets) THEN
                RAISE EXCEPTION 'account_resets holds backups; downgrading would discard them';
            END IF;
            IF EXISTS (SELECT 1 FROM agents WHERE NOT is_primary AND budget_minor = 0) THEN
                RAISE EXCEPTION 'agents holds a reset agent at $0, which 0044 cannot hold';
            END IF;
        END
        $$
        """
    )
    op.execute("DROP FUNCTION reset_account(uuid, text[])")
    op.execute(
        """
        CREATE OR REPLACE FUNCTION agents_ledger_follows_budget() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
        BEGIN
            IF NEW.is_primary THEN
                RETURN NEW;
            END IF;
            IF TG_OP = 'INSERT' THEN
                INSERT INTO agent_cash (agent_id, user_id, balance_minor)
                VALUES (NEW.id, NEW.user_id, 0);
                INSERT INTO cash_movements (user_id, agent_id, kind, amount_minor, created_at)
                VALUES (NEW.user_id, NEW.id, 'opening_deposit', NEW.budget_minor, NEW.created_at);
                RETURN NEW;
            END IF;
            IF NEW.budget_minor IS NOT DISTINCT FROM OLD.budget_minor THEN
                RETURN NEW;
            END IF;
            -- The lock a fill takes, so an edit and a first trade cannot interleave.
            PERFORM 1 FROM agent_cash WHERE agent_id = NEW.id FOR UPDATE;
            IF NOT EXISTS (SELECT 1 FROM fills WHERE agent_id = NEW.id) THEN
                UPDATE cash_movements SET amount_minor = NEW.budget_minor
                 WHERE agent_id = NEW.id AND kind = 'opening_deposit';
            ELSIF NEW.budget_minor > OLD.budget_minor THEN
                INSERT INTO cash_movements (user_id, agent_id, kind, amount_minor)
                VALUES (NEW.user_id, NEW.id, 'top_up', NEW.budget_minor - OLD.budget_minor);
            ELSE
                RAISE EXCEPTION 'budget_decrease_after_trade: an agent that has traded can have '
                    'its budget raised, not lowered (decision D22)'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION cash_movements_guard() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'TRUNCATE' THEN
                RAISE EXCEPTION 'cash_movements is append-only' USING ERRCODE = 'check_violation';
            END IF;
            IF OLD.kind = 'opening_deposit'
               AND NOT EXISTS (SELECT 1 FROM fills WHERE agent_id = OLD.agent_id) THEN
                IF TG_OP = 'DELETE' THEN
                    RETURN OLD;
                END IF;
                IF (NEW.id, NEW.user_id, NEW.agent_id, NEW.kind, NEW.currency, NEW.created_at)
                   IS NOT DISTINCT FROM
                   (OLD.id, OLD.user_id, OLD.agent_id, OLD.kind, OLD.currency, OLD.created_at)
                   AND NEW.fill_id IS NULL THEN
                    RETURN NEW;
                END IF;
            END IF;
            RAISE EXCEPTION 'cash_movements is append-only: only the opening deposit of an agent '
                'that has not traded may change (decision D22)'
                USING ERRCODE = 'check_violation';
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION fills_refuse_change() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'fills are append-only: a recorded trade is corrected by a '
                'counter-trade, never edited (decision D23)'
                USING ERRCODE = 'check_violation';
        END;
        $$
        """
    )
    op.execute("ALTER TABLE agents DROP CONSTRAINT agents_simulated_has_budget")
    op.execute(
        """
        ALTER TABLE agents ADD CONSTRAINT agents_simulated_has_budget
            CHECK (is_primary OR (budget_minor IS NOT NULL AND budget_minor > 0))
        """
    )
    op.execute("DROP TABLE account_resets")
