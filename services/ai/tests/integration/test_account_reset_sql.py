"""Reset account, by group, against a real Postgres (migration 0045, task 18).

Each group alone and all three together, on an account holding a row of every
kind a group erases - and another user's identical account, which no reset may
touch (guideline 5). Then what the reset leaves: an agent at $0 whose first
*Add cash* opens its ledger again; a backup holding every erased row; and the
ledger still closed to `traders_app` outside the function, flag or no flag.
"""

from __future__ import annotations

from collections.abc import Iterator
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.engine.url import make_url
from sqlalchemy.exc import DBAPIError

INSTRUMENT = "10000000-0000-0000-0000-0000000000e1"
APP_PASSWORD = "traders_app_test"
BUDGET = 100_000
RESET_GROUPS = ("main_portfolio", "agents_trading", "followed_topics")

#: The tables each group erases rows from, for an account seeded by `_account`.
ERASES = {
    "main_portfolio": {
        "holdings",
        "target_weights",
        "portfolio_snapshots",
        "observations",
        "proposals",
        "proposal_transitions",
        "proposal_episodes",
        "intents",
        "notifications",
        "narration_transitions",
    },
    "agents_trading": {
        "holdings",
        "portfolio_snapshots",
        "observations",
        "proposals",
        "proposal_attempts",
        "fills",
        "cash_movements",
        "agent_scans",
        "notifications",
        "agent_cash",
    },
    "followed_topics": {"topics", "topic_instruments", "observations", "notifications"},
}

#: Rows each table holds for an account, by who owns them: (primary, agent, topic).
TABLE_FILTERS = {
    "holdings": "user_id = :u",
    "target_weights": "user_id = :u",
    "portfolio_snapshots": "user_id = :u",
    "observations": "user_id = :u",
    "proposals": "user_id = :u",
    "proposal_transitions": "user_id = :u",
    "proposal_attempts": "user_id = :u",
    "proposal_episodes": "user_id = :u",
    "intents": "user_id = :u",
    "notifications": "user_id = :u",
    "narration_transitions": "user_id = :u",
    "fills": "user_id = :u",
    "cash_movements": "user_id = :u",
    "agent_scans": "user_id = :u",
    "topics": "user_id = :u",
    "topic_instruments": "user_id = :u",
}


def _one(connection: Connection, statement: str, **params: object) -> object:
    return connection.execute(text(statement), params).scalar_one()


def _account(connection: Connection) -> dict[str, str]:
    """A user with a row of every kind a reset erases, in every group."""
    user = str(uuid4())
    connection.execute(text("INSERT INTO users (id) VALUES (CAST(:u AS uuid))"), {"u": user})
    primary = str(
        _one(connection, "SELECT id FROM agents WHERE user_id = CAST(:u AS uuid)", u=user)
    )
    agent = str(
        _one(
            connection,
            "INSERT INTO agents (user_id, slug, name, persona, budget_minor) "
            "VALUES (CAST(:u AS uuid), 'trader', 'Trader', 'Buys.', :b) RETURNING id",
            u=user,
            b=BUDGET,
        )
    )
    ids = {"user": user, "primary": primary, "agent": agent}
    params = {"u": user, "p": primary, "a": agent, "i": INSTRUMENT}
    statements = [
        # The real portfolio.
        "INSERT INTO holdings (user_id, agent_id, instrument_id, quantity) VALUES (:u, :p, :i, 5)",
        "INSERT INTO target_weights (user_id, agent_id, instrument_id, weight) "
        "VALUES (:u, :p, :i, 0.5)",
        "INSERT INTO portfolio_snapshots (user_id, agent_id, as_of, total_minor, currency) "
        "VALUES (:u, :p, current_date, 1000, 'USD')",
        "INSERT INTO observations (id, user_id, agent_id, kind, severity, subject_kind, "
        "subject_ref, headline, dedupe_key) VALUES (gen_random_uuid(), :u, :p, "
        "'allocation_drift', 'high', 'portfolio', 'portfolio', 'drift', 'main:' || :k)",
        "INSERT INTO proposals (user_id, agent_id, observation_id, kind, state, expires_at) "
        "SELECT :u, :p, id, 'rebalance', 'approved', now() + interval '1 day' "
        "FROM observations WHERE dedupe_key = 'main:' || :k",
        "INSERT INTO proposal_transitions (proposal_id, user_id, from_state, to_state, surface) "
        "SELECT id, :u, 'pending', 'approved', 'web' FROM proposals "
        "WHERE user_id = :u AND kind = 'rebalance'",
        "INSERT INTO intents (user_id, agent_id, proposal_id, kind) "
        "SELECT :u, :p, id, 'rebalance' FROM proposals WHERE user_id = :u AND kind = 'rebalance'",
        "INSERT INTO proposal_episodes (user_id, agent_id, observation_kind, subject_ref, "
        "observation_id, asked_magnitude) SELECT :u, :p, 'allocation_drift', 'portfolio', id, "
        "0.2 FROM observations WHERE dedupe_key = 'main:' || :k",
        "INSERT INTO notifications (user_id, agent_id, channel, ref_kind, ref_id, route, reason, "
        "status, dedupe_key) SELECT :u, :p, 'telegram', 'observation', id, 'push', 'above_floor', "
        "'pending', 'n-main:' || :k FROM observations WHERE dedupe_key = 'main:' || :k",
        "INSERT INTO narration_transitions (user_id, from_state, to_state) "
        "VALUES (:u, 'narrating', 'unavailable')",
        # A simulated agent's book: a scan, its approved buy and the fill.
        "INSERT INTO agent_scans (id, user_id, agent_id, trigger, finished_at, outcome, steps, "
        "cost_micro_usd, model, briefing, transcript) VALUES (gen_random_uuid(), :u, :a, "
        "'manual', now(), 'trade', 1, 1000, 'm', '{}', '[]')",
        "INSERT INTO observations (id, user_id, agent_id, kind, severity, subject_kind, "
        "subject_ref, headline, dedupe_key) VALUES (gen_random_uuid(), :u, :a, 'agent_trade', "
        "'notable', 'instrument', 'instrument:RSET', 'buy', 'agent:' || :k)",
        "INSERT INTO proposals (user_id, agent_id, observation_id, kind, state, expires_at, "
        "scan_id) SELECT :u, :a, o.id, 'buy', 'approved', now() + interval '1 day', s.id "
        "FROM observations o, agent_scans s WHERE o.dedupe_key = 'agent:' || :k "
        "AND s.agent_id = :a",
        "INSERT INTO proposal_attempts (user_id, proposal_id, surface, reason, agent_price_minor) "
        "SELECT :u, id, 'web', 'market_closed', 1000 FROM proposals WHERE agent_id = :a",
        "INSERT INTO fills (user_id, agent_id, instrument_id, side, quantity, price_minor, "
        "notional_minor, fee_minor, price_source, quote_as_of, source, proposal_id, "
        "idempotency_key) SELECT :u, :a, :i, 'buy', 10, 1000, 10000, 150, 'quote', now(), "
        "'agent', id, 'reset-buy' FROM proposals WHERE agent_id = :a",
        "INSERT INTO holdings (user_id, agent_id, instrument_id, quantity, cost_basis_minor) "
        "VALUES (:u, :a, :i, 10, 1000)",
        "INSERT INTO portfolio_snapshots (user_id, agent_id, as_of, total_minor, currency) "
        "VALUES (:u, :a, current_date, 2000, 'USD')",
        "INSERT INTO notifications (user_id, agent_id, channel, ref_kind, ref_id, route, reason, "
        "status, dedupe_key) SELECT :u, :a, 'telegram', 'proposal', id, 'push', 'above_floor', "
        "'pending', 'n-agent:' || :k FROM proposals WHERE agent_id = :a",
        "UPDATE agents SET budget_minor = :b + 5000 WHERE id = :a",
        # A followed topic, and what it found.
        "INSERT INTO topics (id, user_id, label, status, created_by, confirmed_at) "
        "VALUES (gen_random_uuid(), :u, 'robots', 'active', 'user', now())",
        "INSERT INTO topic_instruments (topic_id, user_id, instrument_id, source) "
        "SELECT id, :u, :i, 'user' FROM topics WHERE user_id = :u",
        "INSERT INTO observations (id, user_id, agent_id, kind, severity, subject_kind, "
        "subject_ref, headline, dedupe_key) VALUES (gen_random_uuid(), :u, :p, 'topic_move', "
        "'notable', 'topic', 'topic:robots', 'robots', 'topic:' || :k)",
        "INSERT INTO notifications (user_id, agent_id, channel, ref_kind, ref_id, route, reason, "
        "status, dedupe_key) SELECT :u, :p, 'digest', 'observation', id, 'digest', 'below_floor', "
        "'pending', 'n-topic:' || :k FROM observations WHERE dedupe_key = 'topic:' || :k",
    ]
    for statement in statements:
        connection.execute(text(statement), {**params, "b": BUDGET, "k": user})
    return ids


def _counts(connection: Connection, user: str) -> dict[str, int]:
    found = {
        table: int(_one(connection, f"SELECT count(*) FROM {table} WHERE {where}", u=user))
        for table, where in TABLE_FILTERS.items()
    }
    found["agent_cash"] = int(
        _one(
            connection,
            "SELECT count(*) FROM agent_cash WHERE user_id = CAST(:u AS uuid) "
            "AND balance_minor > 0",
            u=user,
        )
    )
    return found


def _reset(connection: Connection, user: str, groups: list[str]) -> tuple[str, dict[str, int]]:
    row = connection.execute(
        text("SELECT reset_id, counts FROM reset_account(CAST(:u AS uuid), CAST(:g AS text[]))"),
        {"u": user, "g": groups},
    ).one()
    return str(row.reset_id), dict(row.counts)


@pytest.fixture()
def connection(migrated: Engine) -> Iterator[Connection]:
    with migrated.connect() as connection, connection.begin() as transaction:
        connection.execute(
            text(
                "INSERT INTO instruments (id, symbol, asset_class) VALUES (:id, 'RSET', 'equity')"
            ),
            {"id": INSTRUMENT},
        )
        yield connection
        transaction.rollback()


def test_the_seeded_account_holds_a_row_in_every_table_a_reset_erases(
    connection: Connection,
) -> None:
    account = _account(connection)
    counts = _counts(connection, account["user"])
    assert {table for table, n in counts.items() if n == 0} == set()


@pytest.mark.parametrize(
    "groups",
    [[group] for group in RESET_GROUPS] + [list(RESET_GROUPS)],
    ids=[*RESET_GROUPS, "all"],
)
def test_a_reset_erases_its_groups_and_nothing_else(
    connection: Connection, groups: list[str]
) -> None:
    account = _account(connection)
    bystander = _account(connection)
    before = _counts(connection, account["user"])
    bystander_before = _counts(connection, bystander["user"])

    _, counts = _reset(connection, account["user"], groups)

    after = _counts(connection, account["user"])
    erased = set().union(*(ERASES[group] for group in groups))
    for table, n in after.items():
        if table not in erased:
            assert n == before[table], f"{table} lost rows to a reset of {groups}"
    # A table two groups share keeps the other group's rows; one the groups own goes.
    if set(groups) == set(RESET_GROUPS):
        assert after == dict.fromkeys(after, 0)
    for table in erased - {"agent_cash"}:
        assert counts[table] == before[table] - after[table]
        assert counts[table] > 0, f"{table} had nothing erased by {groups}"
    assert _counts(connection, bystander["user"]) == bystander_before


def test_each_group_leaves_the_others_rows_in_shared_tables(connection: Connection) -> None:
    account = _account(connection)
    _reset(connection, account["user"], ["agents_trading"])
    # The real portfolio's holding and its finding stay, as does the topic's.
    assert (
        _one(
            connection,
            "SELECT count(*) FROM holdings WHERE agent_id = CAST(:p AS uuid)",
            p=account["primary"],
        )
        == 1
    )
    kinds = connection.execute(
        text("SELECT subject_kind FROM observations WHERE user_id = CAST(:u AS uuid) ORDER BY 1"),
        {"u": account["user"]},
    ).scalars()
    assert list(kinds) == ["portfolio", "topic"]


def test_an_agent_reset_to_zero_keeps_its_configuration_and_opens_again_on_add_cash(
    connection: Connection,
) -> None:
    account = _account(connection)
    _reset(connection, account["user"], ["agents_trading"])
    agent = connection.execute(
        text(
            "SELECT a.budget_minor, a.persona, a.state, c.balance_minor FROM agents a "
            "JOIN agent_cash c ON c.agent_id = a.id WHERE a.id = CAST(:a AS uuid)"
        ),
        {"a": account["agent"]},
    ).one()
    assert (agent.budget_minor, agent.persona, agent.state, agent.balance_minor) == (
        0,
        "Buys.",
        "active",
        0,
    )

    # Add cash, as `topUpAgent` does: the budget rises and the ledger reopens.
    connection.execute(
        text("UPDATE agents SET budget_minor = budget_minor + 5000 WHERE id = CAST(:a AS uuid)"),
        {"a": account["agent"]},
    )
    movements = connection.execute(
        text("SELECT kind, amount_minor FROM cash_movements WHERE agent_id = CAST(:a AS uuid)"),
        {"a": account["agent"]},
    ).all()
    assert [(m.kind, m.amount_minor) for m in movements] == [("opening_deposit", 5000)]
    assert (
        _one(
            connection,
            "SELECT balance_minor FROM agent_cash WHERE agent_id = CAST(:a AS uuid)",
            a=account["agent"],
        )
        == 5000
    )


def test_the_backup_holds_every_erased_row_and_the_cash_it_took(connection: Connection) -> None:
    account = _account(connection)
    reset_id, counts = _reset(connection, account["user"], list(RESET_GROUPS))
    row = connection.execute(
        text("SELECT groups, counts, backup FROM account_resets WHERE id = CAST(:r AS uuid)"),
        {"r": reset_id},
    ).one()
    assert row.groups == sorted(RESET_GROUPS)
    assert row.counts == counts
    assert {table: len(rows) for table, rows in row.backup.items()} == counts
    fill = row.backup["fills"][0]
    assert (fill["idempotency_key"], fill["notional_minor"]) == ("reset-buy", 10000)
    assert row.backup["agent_cash"] == [
        {
            "agent_id": account["agent"],
            "balance_minor": BUDGET + 5000 - 10_150,
            "budget_minor": BUDGET + 5000,
        }
    ]


def test_the_flag_is_down_once_the_reset_is_done(connection: Connection) -> None:
    account = _account(connection)
    _reset(connection, account["user"], ["main_portfolio"])
    assert _one(connection, "SELECT current_setting('traders.account_reset', true)") == "off"


@pytest.mark.parametrize(
    "groups", [[], ["everything"], ["main_portfolio", "everything"], [None]], ids=str
)
def test_groups_outside_the_three_are_refused(
    connection: Connection, groups: list[str | None]
) -> None:
    account = _account(connection)
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as refusal:
        _reset(connection, account["user"], groups)  # type: ignore[arg-type]
    savepoint.rollback()
    assert "groups must be a non-empty subset" in str(refusal.value.orig)


def test_a_new_agent_at_zero_is_still_refused(connection: Connection) -> None:
    user = _account(connection)["user"]
    savepoint = connection.begin_nested()
    with pytest.raises(DBAPIError) as refusal:
        connection.execute(
            text(
                "INSERT INTO agents (user_id, slug, name, budget_minor) "
                "VALUES (CAST(:u AS uuid), 'broke', 'Broke', 0)"
            ),
            {"u": user},
        )
    savepoint.rollback()
    assert "cash_movements_sign" in str(refusal.value.orig)


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


def test_the_app_role_resets_through_the_function_and_cannot_erase_the_ledger_itself(
    as_app: Engine,
) -> None:
    with as_app.connect() as connection, connection.begin() as transaction:
        connection.execute(
            text(
                "INSERT INTO instruments (id, symbol, asset_class) VALUES (:id, 'RSET', 'equity')"
            ),
            {"id": INSTRUMENT},
        )
        account = _account(connection)
        # The flag raised by hand opens nothing: the role has no DELETE to use it with.
        connection.execute(text("SELECT set_config('traders.account_reset', 'on', true)"))
        for table in ("fills", "cash_movements", "account_resets"):
            savepoint = connection.begin_nested()
            with pytest.raises(DBAPIError) as refusal:
                connection.execute(
                    text(f"DELETE FROM {table} WHERE user_id = CAST(:u AS uuid)"),
                    {"u": account["user"]},
                )
            savepoint.rollback()
            assert "permission denied" in str(refusal.value.orig)
        connection.execute(text("SELECT set_config('traders.account_reset', 'off', true)"))

        _, counts = _reset(connection, account["user"], list(RESET_GROUPS))
        assert counts["fills"] == 1
        assert _counts(connection, account["user"]) == dict.fromkeys(
            _counts(connection, account["user"]), 0
        )
        transaction.rollback()
