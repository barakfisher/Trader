"""The real portfolio's cash moves for a named reason (D340-D343).

0078 let the main portfolio's cash be set to what the broker shows, and every
such correction moved `budget_minor` - "money deposited" - so a dividend corrected
in read as money put in, and money taken out had no name at all. Now each
movement says what it is:

- **`top_up`** and the new **`withdrawal`**: money put in or taken out. They
  move the budget, which for a primary is its *net* deposits and may go below
  zero once more has been taken out than put in (D341). Recorded as their own
  rows always, before the first trade too, when the writer names them in
  `traders.cash_kind` - an agent's budget edit is unchanged.
- The new **`income`** (dividends, interest) and **`charge`** (a broker's fee, a
  tax): rows that move the balance and not the budget, so they count as gain or
  loss.
- **`adjustment`** (a typo set right) no longer moves the budget either (D342).
  The trigger's adjustment branch is gone.

`traders_app` still cannot write `cash_movements` (0040): the three rows that do
not follow the budget go through `record_primary_cash_movement`, `SECURITY
DEFINER` like the triggers, which writes only those kinds, only for an opened
primary, and only with their own sign.

Downgrade refuses while a movement of a new kind exists, a primary has a
deposit or correction recorded under these rules (0078 reads its budget
differently and would count them twice), or a primary's net deposits are below
zero.

Revision ID: 0080_cash_movement_kinds
Revises: 0079_agent_suggestions
"""

import importlib.util
from pathlib import Path

from alembic import op

revision = "0080_cash_movement_kinds"
down_revision = "0079_agent_suggestions"
branch_labels = None
depends_on = None


def _primary_ledger_module():
    """0078's module, whose trigger this one replaces and whose downgrade restores."""
    path = Path(__file__).with_name("0078_primary_ledger.py")
    spec = importlib.util.spec_from_file_location("primary_ledger_0078", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


_FOLLOWS_BUDGET = """
    CREATE OR REPLACE FUNCTION agents_ledger_follows_budget() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    DECLARE
        v_delta bigint;
        v_kind text;
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
        v_delta := NEW.budget_minor - coalesce(OLD.budget_minor, 0);
        v_kind := current_setting('traders.cash_kind', true);
        -- D341: a primary's net deposits go below zero only by a recorded withdrawal.
        IF NEW.budget_minor < 0 AND v_kind IS DISTINCT FROM 'withdrawal' THEN
            RAISE EXCEPTION 'net_deposits_below_zero: only a withdrawal takes a real portfolio''s '
                'deposits below zero (decision D341)'
                USING ERRCODE = 'check_violation';
        END IF;
        -- D340: a primary's deposit or withdrawal, named by its writer, is its own row.
        IF NEW.is_primary AND OLD.budget_minor IS NOT NULL
           AND v_kind IN ('top_up', 'withdrawal') THEN
            IF (v_kind = 'top_up') <> (v_delta > 0) THEN
                RAISE EXCEPTION 'a % moves the deposits the other way', v_kind
                    USING ERRCODE = 'check_violation';
            END IF;
            INSERT INTO cash_movements (user_id, agent_id, kind, amount_minor)
            VALUES (NEW.user_id, NEW.id, v_kind, v_delta);
            RETURN NEW;
        END IF;
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
        IF v_delta > 0 THEN
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

_KINDS_0078 = "('opening_deposit', 'top_up', 'buy', 'sell', 'adjustment')"
_KINDS = (
    "('opening_deposit', 'top_up', 'buy', 'sell', 'adjustment', 'withdrawal', 'income', 'charge')"
)

_SIGN_0078 = """
    (kind IN ('opening_deposit', 'top_up') AND amount_minor > 0)
    OR (kind = 'buy' AND amount_minor < 0)
    OR (kind = 'sell')
    OR (kind = 'adjustment' AND amount_minor <> 0)
"""
_SIGN = """
    (kind IN ('opening_deposit', 'top_up', 'income') AND amount_minor > 0)
    OR (kind IN ('buy', 'withdrawal', 'charge') AND amount_minor < 0)
    OR (kind = 'sell')
    OR (kind = 'adjustment' AND amount_minor <> 0)
"""

_BUDGET_0078 = """
    (is_primary AND (budget_minor IS NULL OR budget_minor >= 0))
    OR (NOT is_primary AND budget_minor IS NOT NULL AND budget_minor >= 0)
"""
# A primary's budget is its net deposits (D341): below zero once more was taken out than put in.
_BUDGET = """
    is_primary OR (budget_minor IS NOT NULL AND budget_minor >= 0)
"""


APP_ROLE = "traders_app"

_RECORD = """
    CREATE FUNCTION record_primary_cash_movement(
        p_user_id uuid, p_agent_id uuid, p_kind text, p_amount_minor bigint
    ) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
        IF p_kind NOT IN ('income', 'charge', 'adjustment') THEN
            RAISE EXCEPTION 'record_primary_cash_movement writes income, charges and '
                'adjustments, not %', p_kind USING ERRCODE = 'check_violation';
        END IF;
        -- Locked, as the orchestrator's caller already holds it: a reset cannot
        -- unset the primary between this check and the insert.
        PERFORM 1 FROM agents
         WHERE id = p_agent_id AND user_id = p_user_id AND is_primary
           AND budget_minor IS NOT NULL
           FOR NO KEY UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'only an opened real portfolio records %', p_kind
                USING ERRCODE = 'check_violation';
        END IF;
        -- The sign is the table's own CHECK; a balance below zero is agent_cash's.
        INSERT INTO cash_movements (user_id, agent_id, kind, amount_minor)
        VALUES (p_user_id, p_agent_id, p_kind, p_amount_minor);
    END;
    $$
"""
_RECORD_SIGNATURE = "record_primary_cash_movement(uuid, uuid, text, bigint)"


def _constraints(kinds: str, sign: str, budget: str) -> None:
    op.execute("ALTER TABLE cash_movements DROP CONSTRAINT cash_movements_kind_check")
    op.execute(
        "ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_kind_check "
        f"CHECK (kind IN {kinds})"
    )
    op.execute("ALTER TABLE cash_movements DROP CONSTRAINT cash_movements_sign")
    op.execute(f"ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_sign CHECK ({sign})")
    op.execute("ALTER TABLE agents DROP CONSTRAINT agents_simulated_has_budget")
    op.execute(f"ALTER TABLE agents ADD CONSTRAINT agents_simulated_has_budget CHECK ({budget})")


def upgrade() -> None:
    _constraints(_KINDS, _SIGN, _BUDGET)
    op.execute(_FOLLOWS_BUDGET)
    op.execute(_RECORD)
    op.execute(f"REVOKE ALL ON FUNCTION {_RECORD_SIGNATURE} FROM PUBLIC")
    op.execute(f"GRANT EXECUTE ON FUNCTION {_RECORD_SIGNATURE} TO {APP_ROLE}")


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            -- 0078 reads a primary's budget as every deposit and correction, and edits
            -- the opening to it before a fill: a deposit or a correction made under
            -- 0080's rules would be counted twice there.
            IF EXISTS (SELECT 1 FROM cash_movements m JOIN agents a ON a.id = m.agent_id
                        WHERE m.kind IN ('withdrawal', 'income', 'charge')
                           OR (a.is_primary AND m.kind IN ('top_up', 'adjustment')))
               OR EXISTS (SELECT 1 FROM agents WHERE is_primary AND budget_minor < 0) THEN
                RAISE EXCEPTION 'cash movements of a named kind exist: 0078 refuses withdrawals, '
                    'income and charges, reads a real portfolio''s deposits and corrections '
                    'differently, and refuses its deposits below zero';
            END IF;
        END
        $$
        """
    )
    op.execute(f"DROP FUNCTION {_RECORD_SIGNATURE}")
    op.execute(_primary_ledger_module()._FOLLOWS_BUDGET)
    _constraints(_KINDS_0078, _SIGN_0078, _BUDGET_0078)
