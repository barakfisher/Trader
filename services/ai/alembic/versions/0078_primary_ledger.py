"""The real portfolio gets a cash ledger once its opening cash is set (D328-D331).

D1 kept the primary agent passive: no cash, no fills, no movements, refused at
four layers. The holdings/ledger plan (2026-10-27) records real trades made at
IBI against the main portfolio, so it now has the agents' ledger - the same
tables, triggers and fee - opened by the user rather than by creation:

- **Opening** (D328): `agents.budget_minor` stays NULL for a primary until the
  user enters the cash they have at the broker. Setting it creates the
  `agent_cash` row and the opening deposit, as an agent's creation does. The
  holdings already held are not turned into fills: their cost at that moment is
  kept in `agents.opening_holdings_cost_minor`, so "money deposited" is the
  deposits plus what was already invested (D329).
- **`ledger_refuse_primary`** now refuses only a primary whose opening is unset.
- **A correction** (D330): the primary's balance can be set to what the broker
  shows. Before its first fill that edits the opening deposit, as an agent's
  budget edit does; after it, the change is an `adjustment` movement of either
  sign, recorded only when the writer sets `traders.cash_kind = 'adjustment'`
  for its transaction. Without it, a lower budget after trading is still
  refused (D22), so an agent can never be corrected by accident.
- **A reset of `main_portfolio`** (D331) now erases the primary's fills and
  movements with its holdings, and unsets its opening: a reset portfolio is
  one that was never opened.

Downgrade refuses while any primary has a ledger: 0040's triggers would refuse
every row it holds, and dropping them would discard real trades.

Revision ID: 0078_primary_ledger
Revises: 0077_legal_acceptances
"""

import importlib.util
from pathlib import Path

from alembic import op

revision = "0078_primary_ledger"
down_revision = "0077_legal_acceptances"
branch_labels = None
depends_on = None


def _reset_module():
    """0072's module, whose `_reset_account` this migration amends."""
    path = Path(__file__).with_name("0072_reset_research.py")
    spec = importlib.util.spec_from_file_location("reset_research_0072", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


_LEDGER_AGENTS = "v_ledger_agents := CASE WHEN v_trading THEN v_simulated ELSE '{}'::uuid[] END;"
_LEDGER_AGENTS_WITH_PRIMARY = (
    "v_ledger_agents := CASE WHEN v_trading THEN v_simulated ELSE '{}'::uuid[] END\n"
    "                            || CASE WHEN v_main THEN ARRAY[v_primary] ELSE '{}'::uuid[] END;"
)
_ZERO_BUDGETS = "UPDATE agents SET budget_minor = 0 WHERE id = ANY (v_ledger_agents);"
_ZERO_BUDGETS_PRIMARY_UNSET = (
    "UPDATE agents SET budget_minor = 0 WHERE id = ANY (v_ledger_agents) AND NOT is_primary;\n"
    "            -- A reset main portfolio was never opened (D331).\n"
    "            UPDATE agents SET budget_minor = NULL, opening_holdings_cost_minor = NULL\n"
    "             WHERE v_main AND id = v_primary;"
)


def _reset_account(with_primary: bool) -> str:
    module = _reset_module()
    sql = module._reset_account(module.RESEARCH)
    if not with_primary:
        return sql
    for old, new in (
        (_LEDGER_AGENTS, _LEDGER_AGENTS_WITH_PRIMARY),
        (_ZERO_BUDGETS, _ZERO_BUDGETS_PRIMARY_UNSET),
    ):
        assert sql.count(old) == 1, f"0072's reset_account no longer contains {old!r}"
        sql = sql.replace(old, new)
    return sql


_FOLLOWS_BUDGET = """
    CREATE OR REPLACE FUNCTION agents_ledger_follows_budget() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    DECLARE
        v_delta bigint;
    BEGIN
        IF TG_OP = 'INSERT' THEN
            -- A primary is born unopened (D328): its ledger starts when the user sets its cash.
            IF NEW.is_primary THEN
                RETURN NEW;
            END IF;
            INSERT INTO agent_cash (agent_id, user_id, balance_minor)
            VALUES (NEW.id, NEW.user_id, 0);
            INSERT INTO cash_movements (user_id, agent_id, kind, amount_minor, created_at)
            VALUES (NEW.user_id, NEW.id, 'opening_deposit', NEW.budget_minor, NEW.created_at);
            RETURN NEW;
        END IF;
        IF NEW.budget_minor IS NOT DISTINCT FROM OLD.budget_minor THEN
            RETURN NEW;
        END IF;
        -- A primary unset again (a reset, D331): its movements are already gone.
        IF NEW.budget_minor IS NULL THEN
            RETURN NEW;
        END IF;
        -- A primary's first opening, or its first after a reset.
        IF OLD.budget_minor IS NULL THEN
            INSERT INTO agent_cash (agent_id, user_id, balance_minor)
            VALUES (NEW.id, NEW.user_id, 0)
            ON CONFLICT (agent_id) DO NOTHING;
        END IF;
        -- The lock a fill takes, so an edit and a first trade cannot interleave.
        PERFORM 1 FROM agent_cash WHERE agent_id = NEW.id FOR UPDATE;
        IF NOT EXISTS (SELECT 1 FROM fills WHERE agent_id = NEW.id) THEN
            UPDATE cash_movements SET amount_minor = NEW.budget_minor
             WHERE agent_id = NEW.id AND kind = 'opening_deposit' AND NEW.budget_minor > 0;
            IF NOT FOUND AND NEW.budget_minor > 0 THEN
                -- Opened, or reopened after a reset erased it.
                INSERT INTO cash_movements (user_id, agent_id, kind, amount_minor)
                VALUES (NEW.user_id, NEW.id, 'opening_deposit', NEW.budget_minor);
            ELSIF NEW.budget_minor = 0 THEN
                -- No cash at the broker: no deposit, which must be positive. A
                -- deleted movement moves no balance by trigger, so it is moved here.
                DELETE FROM cash_movements WHERE agent_id = NEW.id AND kind = 'opening_deposit'
                RETURNING amount_minor INTO v_delta;
                UPDATE agent_cash SET balance_minor = balance_minor - coalesce(v_delta, 0),
                                      updated_at = now()
                 WHERE agent_id = NEW.id;
            END IF;
            RETURN NEW;
        END IF;
        v_delta := NEW.budget_minor - coalesce(OLD.budget_minor, 0);
        IF NEW.is_primary AND current_setting('traders.cash_kind', true) = 'adjustment' THEN
            -- D330: the balance set to what the broker shows, after trading.
            INSERT INTO cash_movements (user_id, agent_id, kind, amount_minor)
            VALUES (NEW.user_id, NEW.id, 'adjustment', v_delta);
        ELSIF v_delta > 0 THEN
            INSERT INTO cash_movements (user_id, agent_id, kind, amount_minor)
            VALUES (NEW.user_id, NEW.id, 'top_up', v_delta);
        ELSE
            RAISE EXCEPTION 'budget_decrease_after_trade: an agent that has traded can have '
                'its budget raised, not lowered (decision D22)'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END;
    $$
"""

# 0045's, for the downgrade.
_FOLLOWS_BUDGET_0045 = """
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
        PERFORM 1 FROM agent_cash WHERE agent_id = NEW.id FOR UPDATE;
        IF NOT EXISTS (SELECT 1 FROM fills WHERE agent_id = NEW.id) THEN
            UPDATE cash_movements SET amount_minor = NEW.budget_minor
             WHERE agent_id = NEW.id AND kind = 'opening_deposit';
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

_REFUSE_PRIMARY = """
    CREATE OR REPLACE FUNCTION ledger_refuse_primary() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        IF EXISTS (SELECT 1 FROM agents
                    WHERE id = NEW.agent_id AND is_primary AND {condition}) THEN
            RAISE EXCEPTION 'the primary agent is passive{suffix}: % cannot hold a row for the '
                'real portfolio', TG_TABLE_NAME
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END;
    $$
"""


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE agents ADD COLUMN opening_holdings_cost_minor bigint
            CONSTRAINT agents_opening_holdings_cost_primary
            CHECK (opening_holdings_cost_minor IS NULL
                   OR (is_primary AND opening_holdings_cost_minor >= 0))
        """
    )
    op.execute(
        """
        COMMENT ON COLUMN agents.opening_holdings_cost_minor IS
            'A primary''s holdings at cost, in USD minor units, when its cash was set (D329)'
        """
    )
    # 0036 kept a primary's budget NULL; it now holds the deposits once opened.
    op.execute("ALTER TABLE agents DROP CONSTRAINT agents_primary_is_real")
    op.execute(
        """
        ALTER TABLE agents ADD CONSTRAINT agents_primary_is_real
            CHECK (NOT is_primary OR (persona IS NULL AND state = 'active'))
        """
    )
    # A primary's budget, once set, may be zero: no cash at the broker is a real answer.
    op.execute("ALTER TABLE agents DROP CONSTRAINT agents_simulated_has_budget")
    op.execute(
        """
        ALTER TABLE agents ADD CONSTRAINT agents_simulated_has_budget
            CHECK ((is_primary AND (budget_minor IS NULL OR budget_minor >= 0))
                   OR (NOT is_primary AND budget_minor IS NOT NULL AND budget_minor >= 0))
        """
    )
    op.execute("ALTER TABLE cash_movements DROP CONSTRAINT cash_movements_kind_check")
    op.execute(
        """
        ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_kind_check
            CHECK (kind IN ('opening_deposit', 'top_up', 'buy', 'sell', 'adjustment'))
        """
    )
    op.execute("ALTER TABLE cash_movements DROP CONSTRAINT cash_movements_sign")
    op.execute(
        """
        ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_sign CHECK (
            (kind IN ('opening_deposit', 'top_up') AND amount_minor > 0)
            OR (kind = 'buy' AND amount_minor < 0)
            OR (kind = 'sell')
            OR (kind = 'adjustment' AND amount_minor <> 0)
        )
        """
    )
    op.execute(
        _REFUSE_PRIMARY.format(condition="budget_minor IS NULL", suffix=" until its cash is set")
    )
    op.execute(_FOLLOWS_BUDGET)
    op.execute(_reset_account(with_primary=True))


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM agents WHERE is_primary AND budget_minor IS NOT NULL) THEN
                RAISE EXCEPTION 'a real portfolio has a cash ledger: 0040 refuses every row of '
                    'it, and dropping them would discard real trades';
            END IF;
        END
        $$
        """
    )
    op.execute(_reset_account(with_primary=False))
    op.execute(_FOLLOWS_BUDGET_0045)
    op.execute(_REFUSE_PRIMARY.format(condition="true", suffix=""))
    op.execute("ALTER TABLE cash_movements DROP CONSTRAINT cash_movements_sign")
    op.execute(
        """
        ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_sign CHECK (
            (kind IN ('opening_deposit', 'top_up') AND amount_minor > 0)
            OR (kind = 'buy' AND amount_minor < 0)
            OR (kind = 'sell')
        )
        """
    )
    op.execute("ALTER TABLE cash_movements DROP CONSTRAINT cash_movements_kind_check")
    op.execute(
        """
        ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_kind_check
            CHECK (kind IN ('opening_deposit', 'top_up', 'buy', 'sell'))
        """
    )
    op.execute("ALTER TABLE agents DROP CONSTRAINT agents_simulated_has_budget")
    op.execute(
        """
        ALTER TABLE agents ADD CONSTRAINT agents_simulated_has_budget
            CHECK (is_primary OR (budget_minor IS NOT NULL AND budget_minor >= 0))
        """
    )
    op.execute("ALTER TABLE agents DROP CONSTRAINT agents_primary_is_real")
    op.execute(
        """
        ALTER TABLE agents ADD CONSTRAINT agents_primary_is_real CHECK (
            NOT is_primary
            OR (budget_minor IS NULL AND persona IS NULL AND state = 'active')
        )
        """
    )
    op.execute("ALTER TABLE agents DROP COLUMN opening_holdings_cost_minor")
