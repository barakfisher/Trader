"""Agents and agent ownership against a real Postgres (migration 0036).

What the migration promises, each shown by the database refusing or doing it:
every user has exactly one primary agent, made by a trigger rather than by a
writer remembering; the primary cannot carry a budget, a persona or a pause; an
owned row cannot be written without an agent, nor with another user's agent;
and a run carries an agent exactly when it carries a user. The services connect
as `traders_app`, so the last test proves that role can use the new table.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.engine.url import make_url
from sqlalchemy.exc import DBAPIError

#: The single user migration 0001 creates.
SEED_USER = "00000000-0000-0000-0000-000000000001"
OTHER_USER = "00000000-0000-0000-0000-0000000000f1"
INSTRUMENT = "10000000-0000-0000-0000-0000000000f1"

#: A test password for the app role in a disposable database.
APP_PASSWORD = "traders_app_test"


def _refused(connection: Connection, statement: str, **params: object) -> str:
    """Run `statement` in a savepoint and return Postgres's refusal."""
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as refusal:
        connection.execute(text(statement), params)
    savepoint.rollback()
    return str(refusal.value.orig)


def _primary(connection: Connection, user_id: str) -> str:
    return connection.execute(
        text("SELECT id FROM agents WHERE user_id = CAST(:user AS uuid) AND is_primary"),
        {"user": user_id},
    ).scalar_one()


def _add_user(connection: Connection, user_id: str) -> None:
    connection.execute(text("INSERT INTO users (id) VALUES (CAST(:id AS uuid))"), {"id": user_id})


@pytest.fixture()
def connection(migrated: Engine) -> Iterator[Connection]:
    """A connection whose writes are rolled back after each test."""
    with migrated.connect() as connection, connection.begin() as transaction:
        connection.execute(
            text(
                "INSERT INTO instruments (id, symbol, asset_class) VALUES (:id, 'AGNT', 'equity')"
            ),
            {"id": INSTRUMENT},
        )
        yield connection
        transaction.rollback()


def test_the_existing_user_was_given_one_primary_named_main_portfolio(
    connection: Connection,
) -> None:
    rows = connection.execute(
        text("SELECT slug, name, state FROM agents WHERE user_id = CAST(:user AS uuid)"),
        {"user": SEED_USER},
    ).all()
    assert [tuple(row) for row in rows] == [("primary-portfolio", "Main portfolio", "active")]


def test_a_new_user_gets_a_primary_from_the_trigger(connection: Connection) -> None:
    _add_user(connection, OTHER_USER)
    assert _primary(connection, OTHER_USER)


def test_a_user_cannot_have_a_second_primary(connection: Connection) -> None:
    refusal = _refused(
        connection,
        "INSERT INTO agents (user_id, slug, name, is_primary) "
        "VALUES (CAST(:user AS uuid), 'second', 'Second', true)",
        user=SEED_USER,
    )
    assert "agents_one_primary_idx" in refusal


@pytest.mark.parametrize(
    "assignment",
    ["budget_minor = 100000", "persona = 'Bold.'", "state = 'paused'"],
)
def test_the_primary_cannot_be_simulated_or_paused(connection: Connection, assignment: str) -> None:
    refusal = _refused(
        connection,
        f"UPDATE agents SET {assignment} WHERE user_id = CAST(:user AS uuid) AND is_primary",
        user=SEED_USER,
    )
    assert "agents_primary_is_real" in refusal


def test_a_holding_cannot_be_written_without_an_agent(connection: Connection) -> None:
    refusal = _refused(
        connection,
        "INSERT INTO holdings (user_id, instrument_id, quantity) "
        "VALUES (CAST(:user AS uuid), CAST(:instrument AS uuid), '1')",
        user=SEED_USER,
        instrument=INSTRUMENT,
    )
    assert "agent_id" in refusal


def test_a_holding_cannot_name_another_users_agent(connection: Connection) -> None:
    _add_user(connection, OTHER_USER)
    refusal = _refused(
        connection,
        "INSERT INTO holdings (user_id, agent_id, instrument_id, quantity) "
        "VALUES (CAST(:user AS uuid), CAST(:agent AS uuid), CAST(:instrument AS uuid), '1')",
        user=SEED_USER,
        agent=_primary(connection, OTHER_USER),
        instrument=INSTRUMENT,
    )
    assert "holdings_agent_fkey" in refusal


def _simulated(connection: Connection) -> str:
    return connection.execute(
        text(
            "INSERT INTO agents (user_id, slug, name, budget_minor) "
            "VALUES (CAST(:user AS uuid), 'sim', 'Sim', 100000) RETURNING id"
        ),
        {"user": SEED_USER},
    ).scalar_one()


def test_two_agents_may_hold_the_same_instrument_but_one_agent_holds_it_once(
    connection: Connection,
) -> None:
    """0037: the per-user constraint is gone; the per-agent index is the rule."""
    primary, simulated = _primary(connection, SEED_USER), _simulated(connection)
    insert = (
        "INSERT INTO holdings (user_id, agent_id, instrument_id, quantity) "
        "VALUES (CAST(:user AS uuid), CAST(:agent AS uuid), CAST(:instrument AS uuid), '1')"
    )
    for agent in (primary, simulated):
        connection.execute(
            text(insert), {"user": SEED_USER, "agent": agent, "instrument": INSTRUMENT}
        )
    refusal = _refused(connection, insert, user=SEED_USER, agent=primary, instrument=INSTRUMENT)
    assert "holdings_agent_instrument_key" in refusal


def test_two_agents_may_notice_the_same_finding_under_one_dedupe_key(
    connection: Connection,
) -> None:
    """Decision D13: the hash is unchanged, and uniqueness is per agent."""
    primary, simulated = _primary(connection, SEED_USER), _simulated(connection)
    insert = (
        "INSERT INTO observations (user_id, agent_id, kind, headline, dedupe_key) "
        "VALUES (CAST(:user AS uuid), CAST(:agent AS uuid), 'price_move', 'h', 'agents-test-key')"
    )
    for agent in (primary, simulated):
        connection.execute(text(insert), {"user": SEED_USER, "agent": agent})
    refusal = _refused(connection, insert, user=SEED_USER, agent=simulated)
    assert "observations_agent_dedupe_key" in refusal


def test_a_run_carries_an_agent_exactly_when_it_carries_a_user(connection: Connection) -> None:
    # The installation's rescreen: no user, no agent.
    connection.execute(
        text(
            "INSERT INTO runs (kind, run_key, status) "
            "VALUES ('universe_rescreen', 'agents-test-rescreen', 'running')"
        )
    )
    refusal = _refused(
        connection,
        "INSERT INTO runs (user_id, kind, run_key, status) "
        "VALUES (CAST(:user AS uuid), 'snapshot', 'agents-test-snapshot', 'running')",
        user=SEED_USER,
    )
    assert "runs_agent_follows_user" in refusal


def test_installation_run_keys_stay_unique_among_themselves(connection: Connection) -> None:
    insert = (
        "INSERT INTO runs (kind, run_key, status) "
        "VALUES ('universe_rescreen', 'agents-test-twice', 'skipped')"
    )
    connection.execute(text(insert))
    refusal = _refused(connection, insert)
    assert "run_key" in refusal


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


def test_the_app_role_reads_and_writes_agents(as_app: Engine) -> None:
    with as_app.connect() as connection, connection.begin() as transaction:
        connection.execute(
            text(
                "INSERT INTO agents (user_id, slug, name, budget_minor) "
                "VALUES (CAST(:user AS uuid), 'app-role', 'App role', 100000)"
            ),
            {"user": SEED_USER},
        )
        count = connection.execute(
            text("SELECT count(*) FROM agents WHERE user_id = CAST(:user AS uuid)"),
            {"user": SEED_USER},
        ).scalar_one()
        assert count == 2
        transaction.rollback()


def _propose(connection: Connection, agent: str, kind: str) -> None:
    observation = connection.execute(
        text(
            "INSERT INTO observations (user_id, agent_id, kind, headline, dedupe_key) "
            "VALUES (CAST(:user AS uuid), CAST(:agent AS uuid), 'allocation_drift', 'h', "
            "'agents-test-' || gen_random_uuid()) RETURNING id"
        ),
        {"user": SEED_USER, "agent": agent},
    ).scalar_one()
    connection.execute(
        text(
            "INSERT INTO proposals (user_id, agent_id, observation_id, kind, expires_at) "
            "VALUES (CAST(:user AS uuid), CAST(:agent AS uuid), :observation, :kind, now())"
        ),
        {"user": SEED_USER, "agent": agent, "observation": observation, "kind": kind},
    )


def test_the_primary_is_asked_to_acknowledge_never_to_trade(connection: Connection) -> None:
    """0038, decision D1: only `rebalance` may be raised against the real portfolio."""
    primary = _primary(connection, SEED_USER)
    _propose(connection, primary, "rebalance")
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as refusal:
        _propose(connection, primary, "trade")
    savepoint.rollback()
    assert "the primary agent is passive" in str(refusal.value.orig)


def test_a_simulated_agent_may_receive_other_kinds(connection: Connection) -> None:
    _propose(connection, _simulated(connection), "trade")
