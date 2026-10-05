"""The ledger against a real Postgres (migration 0040).

Every rule the migration moved into the database, each shown by Postgres doing
it or refusing it: an agent's cash and opening deposit appear when it is made;
a fill writes its own cash effect and the balance follows; cash never goes
below zero; the budget is the sum of deposits (D22); fills and movements are
append-only (D23); whole shares only (D9); the real portfolio has no ledger
(D1); and `traders_app`, as which every service connects, may insert a fill
and lock the cash row but write nothing else.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.engine.url import make_url
from sqlalchemy.exc import DBAPIError

SEED_USER = "00000000-0000-0000-0000-000000000001"
INSTRUMENT = "10000000-0000-0000-0000-0000000000c1"
APP_PASSWORD = "traders_app_test"
BUDGET = 100_000


def _refused(connection: Connection, statement: str, **params: object) -> str:
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as refusal:
        connection.execute(text(statement), params)
    savepoint.rollback()
    return str(refusal.value.orig)


def _agent(connection: Connection, budget: int = BUDGET, slug: str = "ledger-agent") -> str:
    return connection.execute(
        text(
            "INSERT INTO agents (user_id, slug, name, budget_minor) "
            "VALUES (CAST(:user AS uuid), :slug, :slug, :budget) RETURNING id"
        ),
        {"user": SEED_USER, "slug": slug, "budget": budget},
    ).scalar_one()


def _fill(
    connection: Connection,
    agent: str,
    side: str = "buy",
    quantity: str = "10",
    price: int = 1_000,
    fee: int = 150,
    key: str = "k1",
) -> str:
    return connection.execute(
        text(
            """
            INSERT INTO fills (user_id, agent_id, instrument_id, side, quantity, price_minor,
                               notional_minor, fee_minor, price_source, quote_as_of, source,
                               idempotency_key)
            VALUES (CAST(:user AS uuid), :agent, :instrument, :side, CAST(:quantity AS numeric),
                    :price, CAST(:quantity AS numeric) * :price, :fee, 'quote', now(),
                    'manual_user_override', :key)
            RETURNING id
            """
        ),
        {
            "user": SEED_USER,
            "agent": agent,
            "instrument": INSTRUMENT,
            "side": side,
            "quantity": quantity,
            "price": price,
            "fee": fee,
            "key": key,
        },
    ).scalar_one()


def _cash(connection: Connection, agent: str) -> int:
    return connection.execute(
        text("SELECT balance_minor FROM agent_cash WHERE agent_id = :agent"), {"agent": agent}
    ).scalar_one()


def _movements(connection: Connection, agent: str) -> list[tuple[str, int]]:
    rows = connection.execute(
        text(
            "SELECT kind, amount_minor FROM cash_movements WHERE agent_id = :agent "
            "ORDER BY created_at, kind"
        ),
        {"agent": agent},
    ).all()
    return [(row.kind, row.amount_minor) for row in rows]


@pytest.fixture()
def connection(migrated: Engine) -> Iterator[Connection]:
    with migrated.connect() as connection, connection.begin() as transaction:
        connection.execute(
            text(
                "INSERT INTO instruments (id, symbol, asset_class) VALUES (:id, 'LDGR', 'equity')"
            ),
            {"id": INSTRUMENT},
        )
        yield connection
        transaction.rollback()


def test_a_new_agent_starts_with_its_budget_in_cash(connection: Connection) -> None:
    agent = _agent(connection)
    assert _cash(connection, agent) == BUDGET
    assert _movements(connection, agent) == [("opening_deposit", BUDGET)]


def test_a_simulated_agent_must_have_a_budget(connection: Connection) -> None:
    refusal = _refused(
        connection,
        "INSERT INTO agents (user_id, slug, name) VALUES (CAST(:user AS uuid), 'nob', 'nob')",
        user=SEED_USER,
    )
    assert "agents_simulated_has_budget" in refusal


def test_a_buy_debits_notional_and_fee_and_a_sell_credits_notional_less_fee(
    connection: Connection,
) -> None:
    agent = _agent(connection)
    _fill(connection, agent, "buy", "10", 1_000, 150, "b")
    _fill(connection, agent, "sell", "4", 1_200, 150, "s")
    assert _cash(connection, agent) == BUDGET - 10_150 + 4_650
    kinds = sorted(_movements(connection, agent))
    assert kinds == [("buy", -10_150), ("opening_deposit", BUDGET), ("sell", 4_650)]


def test_cash_never_goes_below_zero(connection: Connection) -> None:
    agent = _agent(connection, budget=10_000)
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as refusal:
        _fill(connection, agent, "buy", "10", 1_000, 150)
    savepoint.rollback()
    assert "balance_minor" in str(refusal.value.orig)
    assert _cash(connection, agent) == 10_000


def test_a_fractional_quantity_is_refused(connection: Connection) -> None:
    agent = _agent(connection)
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as refusal:
        _fill(connection, agent, quantity="1.5")
    savepoint.rollback()
    assert "fills_quantity_check" in str(refusal.value.orig)


def test_notional_must_equal_quantity_times_price(connection: Connection) -> None:
    agent = _agent(connection)
    refusal = _refused(
        connection,
        """
        INSERT INTO fills (user_id, agent_id, instrument_id, side, quantity, price_minor,
                           notional_minor, fee_minor, price_source, source, idempotency_key)
        VALUES (CAST(:user AS uuid), :agent, :instrument, 'buy', 2, 1000, 1999, 150, 'user',
                'manual_user_override', 'n')
        """,
        user=SEED_USER,
        agent=agent,
        instrument=INSTRUMENT,
    )
    assert "fills_notional_is_quantity_times_price" in refusal


def test_one_idempotency_key_is_one_fill(connection: Connection) -> None:
    agent = _agent(connection)
    _fill(connection, agent, key="same")
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as refusal:
        _fill(connection, agent, key="same")
    savepoint.rollback()
    assert "fills_agent_idempotency_key" in str(refusal.value.orig)


def test_before_the_first_fill_a_budget_edit_replaces_the_opening_deposit(
    connection: Connection,
) -> None:
    agent = _agent(connection)
    connection.execute(text("UPDATE agents SET budget_minor = 40000 WHERE id = :a"), {"a": agent})
    assert _movements(connection, agent) == [("opening_deposit", 40_000)]
    assert _cash(connection, agent) == 40_000


def test_after_a_fill_a_raise_is_a_top_up_and_a_cut_is_refused(connection: Connection) -> None:
    agent = _agent(connection)
    _fill(connection, agent)
    connection.execute(text("UPDATE agents SET budget_minor = 150000 WHERE id = :a"), {"a": agent})
    assert ("top_up", 50_000) in _movements(connection, agent)
    assert _cash(connection, agent) == 150_000 - 10_150
    refusal = _refused(connection, "UPDATE agents SET budget_minor = 120000 WHERE id = :a", a=agent)
    assert "budget_decrease_after_trade" in refusal
    deposits = connection.execute(
        text(
            "SELECT sum(amount_minor) FROM cash_movements "
            "WHERE agent_id = :a AND kind IN ('opening_deposit', 'top_up')"
        ),
        {"a": agent},
    ).scalar_one()
    budget = connection.execute(
        text("SELECT budget_minor FROM agents WHERE id = :a"), {"a": agent}
    ).scalar_one()
    assert deposits == budget


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE fills SET price_minor = 1 WHERE id = :fill",
        "DELETE FROM fills WHERE id = :fill",
        "UPDATE cash_movements SET amount_minor = 1 WHERE fill_id = :fill",
        "DELETE FROM cash_movements WHERE fill_id = :fill",
        "UPDATE cash_movements SET amount_minor = 1 WHERE agent_id = :agent "
        "AND kind = 'opening_deposit'",
        "TRUNCATE fills CASCADE",
        "TRUNCATE cash_movements",
    ],
)
def test_the_ledger_is_append_only_even_for_the_owner(
    connection: Connection, statement: str
) -> None:
    agent = _agent(connection)
    fill = _fill(connection, agent)
    refusal = _refused(connection, statement, fill=fill, agent=agent)
    assert "append-only" in refusal


def test_an_agent_that_never_traded_can_be_deleted_one_that_traded_cannot(
    connection: Connection,
) -> None:
    untraded = _agent(connection, slug="untraded")
    connection.execute(text("DELETE FROM agents WHERE id = :a"), {"a": untraded})
    assert _movements(connection, untraded) == []
    traded = _agent(connection, slug="traded")
    _fill(connection, traded)
    refusal = _refused(connection, "DELETE FROM agents WHERE id = :a", a=traded)
    assert "fills_agent_fkey" in refusal


def test_the_real_portfolio_has_no_ledger(connection: Connection) -> None:
    primary = connection.execute(
        text("SELECT id FROM agents WHERE user_id = CAST(:u AS uuid) AND is_primary"),
        {"u": SEED_USER},
    ).scalar_one()
    assert (
        connection.execute(
            text("SELECT count(*) FROM agent_cash WHERE agent_id = :a"), {"a": primary}
        ).scalar_one()
        == 0
    )
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as refusal:
        _fill(connection, primary)
    savepoint.rollback()
    assert "primary agent is passive" in str(refusal.value.orig)


@pytest.fixture(scope="module")
def as_app(migrated: Engine, database_url: str) -> Iterator[Engine]:
    """An engine logged in as `traders_app`, as every service is."""
    with migrated.begin() as connection:
        connection.execute(text(f"ALTER ROLE traders_app WITH LOGIN PASSWORD '{APP_PASSWORD}'"))
    url = make_url(database_url).set(
        drivername="postgresql+psycopg", username="traders_app", password=APP_PASSWORD
    )
    engine = create_engine(url, future=True)
    yield engine
    engine.dispose()


def test_the_app_role_trades_through_the_triggers_and_writes_nothing_else(
    as_app: Engine,
) -> None:
    with as_app.connect() as connection, connection.begin() as transaction:
        connection.execute(
            text(
                "INSERT INTO instruments (id, symbol, asset_class) VALUES (:id, 'LDGR', 'equity')"
            ),
            {"id": INSTRUMENT},
        )
        agent = _agent(connection)
        # D3's row lock is permitted...
        connection.execute(
            text("SELECT balance_minor FROM agent_cash WHERE agent_id = :a FOR UPDATE"),
            {"a": agent},
        )
        _fill(connection, agent)
        connection.execute(
            text("UPDATE agents SET budget_minor = 150000 WHERE id = :a"), {"a": agent}
        )
        assert _cash(connection, agent) == 150_000 - 10_150
        # ...and every direct write to the balance or the movements is not.
        for statement in (
            "UPDATE agent_cash SET balance_minor = 1 WHERE agent_id = :a",
            "INSERT INTO cash_movements (user_id, agent_id, kind, amount_minor) "
            "VALUES (CAST(:u AS uuid), :a, 'top_up', 1)",
            "DELETE FROM agent_cash WHERE agent_id = :a",
        ):
            refusal = _refused(connection, statement, a=agent, u=SEED_USER)
            assert "permission denied" in refusal
        transaction.rollback()
