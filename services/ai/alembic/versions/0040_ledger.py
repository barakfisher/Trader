"""The ledger: an agent's cash, every movement of it, and every fill (Stage 3, PR 3).

`docs/PROPOSAL-MULTI-AGENT.md` §5.1 and §10 D2, D6, D9, D21-D24. Until now the
system had no cash at all: `intents` record assent and hold no money. This
revision adds three tables, and puts every rule that can be a property of the
data into the database, so a bug in the application cannot break them:

- **`fills`**: one row per trade - side, whole-share quantity (D9, a CHECK),
  price and fee in integer minor units, where the price came from (`quote` with
  the quote's time and delay, or `user` for D21's typed price), and who decided
  (`manual_user_override` or `agent`, §5.3). `notional_minor` is stored and
  checked equal to `quantity × price`. An idempotency key per agent makes a
  double-submitted trade one fill.
- **`cash_movements`**: every change to an agent's cash - the opening deposit,
  top-ups (D22), and the debit or credit of each fill. **Nothing writes a
  movement directly.** A deposit follows `agents.budget_minor`; a trade's
  movement follows its fill (`−(notional + fee)` on a buy, `notional − fee` on a
  sell, D6). Both by trigger, so `agents.budget_minor` always equals the sum of
  deposits and every fill has exactly its cash effect.
- **`agent_cash`**: the balance, one row per simulated agent, maintained by a
  trigger from the movements and **never negative** (a CHECK). An overspend that
  slipped past the application's check under the row lock still fails here.

D22 in the database: creating a simulated agent writes its cash row and opening
deposit; until its first fill a budget edit rewrites the opening deposit
(nothing has been measured against it yet); after it, an increase is a dated
top-up and a decrease is refused. D23: fills are append-only, and so are
movements, with that one pre-trade exception.

**D1's fourth layer:** no ledger row can name a primary agent - the real
portfolio has no cash and never trades.

**Privileges.** The services connect as `traders_app` (0033). It may read all
three tables and insert fills; it cannot write `agent_cash` or `cash_movements`
at all (the triggers that do are `SECURITY DEFINER`, running as the owner), and
cannot update or delete a fill. It holds `UPDATE (updated_at)` on `agent_cash`
only so that `SELECT ... FOR UPDATE` - the row lock D3 takes - is permitted.
Triggers also refuse UPDATE, DELETE and TRUNCATE for the owner, as 0026 does.

**Deleting an agent.** Agents are archived, not deleted (D18), and one that has
traded cannot be: `fills` references it without a cascade. One that never
traded can, and its cash row and opening deposit go with it - which tests rely
on, and which loses no history.

The downgrade refuses while a fill or a top-up exists: it would discard the
ledger. Opening deposits are re-derived from budgets by the upgrade, so they
alone do not block it.

Revision ID: 0040_ledger
Revises: 0039_retire_mastra
"""

from alembic import op

revision = "0040_ledger"
down_revision = "0039_retire_mastra"
branch_labels = None
depends_on = None

APP_ROLE = "traders_app"


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE agents ADD CONSTRAINT agents_simulated_has_budget
            CHECK (is_primary OR (budget_minor IS NOT NULL AND budget_minor > 0))
        """
    )
    op.execute(
        """
        CREATE TABLE agent_cash (
            agent_id      uuid PRIMARY KEY,
            user_id       uuid NOT NULL REFERENCES users(id),
            balance_minor bigint NOT NULL CHECK (balance_minor >= 0),
            currency      text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
            updated_at    timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT agent_cash_agent_fkey FOREIGN KEY (user_id, agent_id)
                REFERENCES agents (user_id, id) ON DELETE CASCADE
        )
        """
    )
    op.execute(
        """
        CREATE TABLE fills (
            id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id             uuid NOT NULL REFERENCES users(id),
            agent_id            uuid NOT NULL,
            instrument_id       uuid NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
            side                text NOT NULL CHECK (side IN ('buy', 'sell')),
            quantity            numeric(38, 18) NOT NULL
                CHECK (quantity > 0 AND quantity = trunc(quantity)),
            price_minor         bigint NOT NULL CHECK (price_minor > 0),
            notional_minor      bigint NOT NULL,
            fee_minor           bigint NOT NULL CHECK (fee_minor >= 0),
            currency            text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
            price_source        text NOT NULL CHECK (price_source IN ('quote', 'user')),
            quote_as_of         timestamptz,
            quote_delay_seconds integer CHECK (quote_delay_seconds >= 0),
            source              text NOT NULL
                CHECK (source IN ('manual_user_override', 'agent')),
            proposal_id         uuid REFERENCES proposals(id) ON DELETE RESTRICT,
            idempotency_key     text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
            created_at          timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT fills_agent_fkey FOREIGN KEY (user_id, agent_id)
                REFERENCES agents (user_id, id),
            CONSTRAINT fills_notional_is_quantity_times_price
                CHECK (notional_minor = quantity * price_minor),
            CONSTRAINT fills_quote_price_is_dated
                CHECK ((price_source = 'quote') = (quote_as_of IS NOT NULL)),
            CONSTRAINT fills_manual_has_no_proposal
                CHECK (source <> 'manual_user_override' OR proposal_id IS NULL),
            CONSTRAINT fills_agent_idempotency_key UNIQUE (agent_id, idempotency_key),
            CONSTRAINT fills_one_per_proposal UNIQUE (proposal_id)
        )
        """
    )
    op.execute("CREATE INDEX fills_agent_created_idx ON fills (agent_id, created_at)")
    op.execute(
        """
        CREATE TABLE cash_movements (
            id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id       uuid NOT NULL REFERENCES users(id),
            agent_id      uuid NOT NULL,
            kind          text NOT NULL
                CHECK (kind IN ('opening_deposit', 'top_up', 'buy', 'sell')),
            amount_minor  bigint NOT NULL,
            currency      text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
            fill_id       uuid UNIQUE REFERENCES fills(id) ON DELETE RESTRICT,
            created_at    timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT cash_movements_agent_fkey FOREIGN KEY (user_id, agent_id)
                REFERENCES agents (user_id, id) ON DELETE CASCADE,
            CONSTRAINT cash_movements_trade_has_fill
                CHECK ((kind IN ('buy', 'sell')) = (fill_id IS NOT NULL)),
            CONSTRAINT cash_movements_sign CHECK (
                (kind IN ('opening_deposit', 'top_up') AND amount_minor > 0)
                OR (kind = 'buy' AND amount_minor < 0)
                OR (kind = 'sell')
            )
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX cash_movements_one_opening ON cash_movements (agent_id)
            WHERE kind = 'opening_deposit'
        """
    )
    op.execute(
        "CREATE INDEX cash_movements_agent_created_idx ON cash_movements (agent_id, created_at)"
    )

    # D1, fourth layer: the real portfolio has no ledger.
    op.execute(
        """
        CREATE FUNCTION ledger_refuse_primary() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF EXISTS (SELECT 1 FROM agents WHERE id = NEW.agent_id AND is_primary) THEN
                RAISE EXCEPTION 'the primary agent is passive: % cannot hold a row for the real '
                    'portfolio', TG_TABLE_NAME
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    for table in ("agent_cash", "fills", "cash_movements"):
        op.execute(
            f"""
            CREATE TRIGGER {table}_refuse_primary BEFORE INSERT ON {table}
                FOR EACH ROW EXECUTE FUNCTION ledger_refuse_primary()
            """
        )

    # D23: a fill is final.
    op.execute(
        """
        CREATE FUNCTION fills_refuse_change() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'fills are append-only: a recorded trade is corrected by a '
                'counter-trade, never edited (decision D23)'
                USING ERRCODE = 'check_violation';
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER fills_append_only BEFORE UPDATE OR DELETE ON fills
            FOR EACH ROW EXECUTE FUNCTION fills_refuse_change()
        """
    )
    op.execute(
        """
        CREATE TRIGGER fills_no_truncate BEFORE TRUNCATE ON fills
            FOR EACH STATEMENT EXECUTE FUNCTION fills_refuse_change()
        """
    )

    # Movements are append-only too, except the opening deposit of an agent that
    # has not traded: D22 lets its budget be edited, or the agent be deleted.
    op.execute(
        """
        CREATE FUNCTION cash_movements_guard() RETURNS trigger
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
        CREATE TRIGGER cash_movements_append_only BEFORE UPDATE OR DELETE ON cash_movements
            FOR EACH ROW EXECUTE FUNCTION cash_movements_guard()
        """
    )
    op.execute(
        """
        CREATE TRIGGER cash_movements_no_truncate BEFORE TRUNCATE ON cash_movements
            FOR EACH STATEMENT EXECUTE FUNCTION cash_movements_guard()
        """
    )

    # A movement moves the balance; the CHECK refuses a balance below zero.
    op.execute(
        """
        CREATE FUNCTION cash_movements_apply() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
        BEGIN
            UPDATE agent_cash
               SET balance_minor = balance_minor + NEW.amount_minor
                                   - CASE WHEN TG_OP = 'UPDATE' THEN OLD.amount_minor ELSE 0 END,
                   updated_at = now()
             WHERE agent_id = NEW.agent_id;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'agent % has no cash row', NEW.agent_id
                    USING ERRCODE = 'foreign_key_violation';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER cash_movements_move_balance AFTER INSERT OR UPDATE ON cash_movements
            FOR EACH ROW EXECUTE FUNCTION cash_movements_apply()
        """
    )

    # A fill writes its own cash effect (D6): the fee always leaves cash.
    op.execute(
        """
        CREATE FUNCTION fills_move_cash() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
        BEGIN
            INSERT INTO cash_movements (user_id, agent_id, kind, amount_minor, fill_id, created_at)
            VALUES (
                NEW.user_id, NEW.agent_id, NEW.side,
                CASE WHEN NEW.side = 'buy' THEN -(NEW.notional_minor + NEW.fee_minor)
                     ELSE NEW.notional_minor - NEW.fee_minor END,
                NEW.id, NEW.created_at
            );
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER fills_move_cash AFTER INSERT ON fills
            FOR EACH ROW EXECUTE FUNCTION fills_move_cash()
        """
    )

    # D22: the budget is the sum of deposits.
    op.execute(
        """
        CREATE FUNCTION agents_ledger_follows_budget() RETURNS trigger
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
        CREATE TRIGGER agents_ledger_follows_budget
            AFTER INSERT OR UPDATE OF budget_minor ON agents
            FOR EACH ROW EXECUTE FUNCTION agents_ledger_follows_budget()
        """
    )

    # Agents made before the ledger get theirs, dated when they were created.
    op.execute(
        """
        INSERT INTO agent_cash (agent_id, user_id, balance_minor)
        SELECT id, user_id, 0 FROM agents WHERE NOT is_primary
        """
    )
    op.execute(
        """
        INSERT INTO cash_movements (user_id, agent_id, kind, amount_minor, created_at)
        SELECT user_id, id, 'opening_deposit', budget_minor, created_at
          FROM agents WHERE NOT is_primary
        """
    )

    # 0033's default privileges granted the app role everything; take back the writes
    # only the triggers make. A role created by 0033 always exists at this revision.
    op.execute(f"REVOKE INSERT, UPDATE, DELETE ON agent_cash FROM {APP_ROLE}")
    op.execute(f"GRANT UPDATE (updated_at) ON agent_cash TO {APP_ROLE}")
    op.execute(f"REVOKE INSERT, UPDATE, DELETE ON cash_movements FROM {APP_ROLE}")
    op.execute(f"REVOKE UPDATE, DELETE ON fills FROM {APP_ROLE}")


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM fills)
               OR EXISTS (SELECT 1 FROM cash_movements WHERE kind = 'top_up') THEN
                RAISE EXCEPTION 'the ledger holds fills or top-ups; downgrading would discard '
                    'them. To discard them deliberately: ALTER TABLE cash_movements DISABLE '
                    'TRIGGER USER; ALTER TABLE fills DISABLE TRIGGER USER; DELETE FROM '
                    'cash_movements WHERE kind <> ''opening_deposit''; DELETE FROM fills';
            END IF;
        END;
        $$
        """
    )
    op.execute("DROP TRIGGER agents_ledger_follows_budget ON agents")
    op.execute("DROP TABLE cash_movements")
    op.execute("DROP TABLE fills")
    op.execute("DROP TABLE agent_cash")
    for function in (
        "agents_ledger_follows_budget",
        "fills_move_cash",
        "cash_movements_apply",
        "cash_movements_guard",
        "fills_refuse_change",
        "ledger_refuse_primary",
    ):
        op.execute(f"DROP FUNCTION {function}()")
    op.execute("ALTER TABLE agents DROP CONSTRAINT agents_simulated_has_budget")
