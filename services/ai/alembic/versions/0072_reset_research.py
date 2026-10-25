"""Reset account: the main portfolio's group erases its research too (D254, D289-D293).

Research rates the main portfolio's holdings, so its runs and ratings belong to
the `main_portfolio` group beside the findings and narration's history. 0045's
function predates them, and 0070 relied on cascades from `agents` - but no
reset deletes an agent, so every reset kept every rating, and a reset portfolio
still showed the old portfolio's Bullish and Bearish words on the research page.

- **What goes**: the user's finished `research_runs` and their
  `research_ratings`, each row kept in the backup like every other erased table.
- **What stays**: a run still `running`, with the ratings it has written. The
  AI service writes each rating against its run and closes the run by id; with
  the row gone, both would fail mid-run. The next run replaces its ratings.
- **Also kept**: `user_settings.research_agent_id` (settings are always kept),
  and the `research` runs and `llm_calls` rows (bookkeeping, as 0045 says).

The function is 0045's, the research block apart; the downgrade restores 0045's
exactly. `CREATE OR REPLACE` keeps its grant to `traders_app`.

Revision ID: 0072_reset_research
Revises: 0071_user_sessions
"""

from alembic import op

revision = "0072_reset_research"
down_revision = "0071_user_sessions"
branch_labels = None
depends_on = None

#: 0045's groups; unchanged.
RESET_GROUPS = ("main_portfolio", "agents_trading", "followed_topics")

#: Ratings before their runs, which they reference; a running run is left alone.
RESEARCH = """
            -- Research on the main portfolio (D254): finished runs and their ratings.
            WITH gone AS (
                DELETE FROM research_ratings
                 WHERE v_main AND user_id = p_user_id
                   AND run_id IN (SELECT id FROM research_runs
                                   WHERE user_id = p_user_id AND status <> 'running')
                RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('research_ratings', v_rows);

            WITH gone AS (
                DELETE FROM research_runs
                 WHERE v_main AND user_id = p_user_id AND status <> 'running'
                RETURNING *)
            SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]') INTO v_rows FROM gone;
            v_backup := v_backup || jsonb_build_object('research_runs', v_rows);

"""


def _sql_array(values: tuple[str, ...]) -> str:
    return "ARRAY[" + ", ".join(f"'{value}'" for value in values) + "]::text[]"


def _reset_account(research: str) -> str:
    """0045's `reset_account`, with `research` erased before the cash goes to $0."""
    return f"""
        CREATE OR REPLACE FUNCTION reset_account(p_user_id uuid, p_groups text[])
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

{research}            -- Cash and budget to $0. Each agent's balance and budget as they were
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


def upgrade() -> None:
    op.execute(_reset_account(RESEARCH))


def downgrade() -> None:
    op.execute(_reset_account(""))
