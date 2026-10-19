"""The assistant's tools: the agents' read-only tools, plus the user's account and the app.

Shared with the agents' scans (D53): `search_universe`, `get_quote`,
`get_price_history`, `get_findings`, `get_news` and `explain_concept` are the
same handlers, run in a `ToolContext` whose agent is the user's primary - the
real portfolio. `get_position` is left out: `get_portfolio` answers the same
question for any of the user's portfolios.

The assistant's own tools read the account the way its screens do. **Nothing
here writes anything a user owns**, and nothing can: there is no tool that
approves, trades or changes a setting, so a model persuaded to try has nothing
to call (MEMORY.md, "Planned: the assistant", guardrails). Every query is scoped
by `user_id` (guideline 5).

As in `agents/tools.py`: money leaves as decimal strings in its currency, never
a float; a model's mistake comes back as `{"error": ...}` it can correct; an
unavailable price is reported as unpriced, never as zero (guideline 7).
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.agents.mandate import MANDATE_SET_SQL, ready_to_scan
from app.agents.scan_budget import start_of_utc_day
from app.agents.scan_schedule import describe_next_scan
from app.agents.tools import TOOLS_BY_NAME as AGENT_TOOLS
from app.agents.tools import Tool, ToolContext, _object, _stored_closes, find_listing, money
from app.assistant.product_guide import SECTIONS
from app.llm.base import ToolSpec

#: The agents' tools the assistant shares, in the order it is offered them.
SHARED = (
    "search_universe",
    "get_quote",
    "get_price_history",
    "get_findings",
    "get_news",
    "explain_concept",
)
#: Rows any one list answer returns: enough to answer from, few enough to stay cheap.
MAX_ROWS = 15
DEFAULT_OBSERVATION_DAYS = 7
MAX_OBSERVATION_DAYS = 90
#: Snapshots compared against for "how has it done": a day, a week, a month back.
RETURN_WINDOWS = {"1d": 1, "7d": 7, "30d": 30}
#: Topic instruments listed per topic.
MAX_TOPIC_INSTRUMENTS = 30
PROPOSAL_STATES = ("pending", "approved", "rejected", "snoozed", "expired")
#: The currency totals are summed in when no snapshot names one (guideline 10).
BASE_CURRENCY = "USD"
#: Calendar days searched back from the month's start for each holding's last close.
MONTH_START_CLOSE_DAYS = 10


def _pct(numerator: Decimal, denominator: Decimal) -> str | None:
    if denominator == 0:
        return None
    return str((numerator / denominator * 100).quantize(Decimal("0.01")))


def _quantity(value: Any) -> str:
    return f"{Decimal(value).normalize():f}"


def _limit(arguments: Mapping[str, Any]) -> int | None:
    value = arguments.get("limit", MAX_ROWS)
    return value if isinstance(value, int) and 1 <= value <= MAX_ROWS else None


def _agents(connection: Connection, user_id: str) -> list[Any]:
    return list(
        connection.execute(
            text(
                """
                SELECT a.id::text AS id, a.name, a.is_primary, a.state, a.persona,
                       a.scan_schedule, a.budget_minor, a.currency, a.llm_budget_micro_usd,
                       a.created_at, """
                + MANDATE_SET_SQL
                + """ AS mandate_set
                  FROM agents a
                 WHERE a.user_id = CAST(:user AS uuid)
                 ORDER BY a.is_primary DESC, a.created_at
                """
            ),
            {"user": user_id},
        ).all()
    )


def primary_agent_id(connection: Connection, user_id: str) -> str | None:
    return connection.execute(
        text("SELECT id::text FROM agents WHERE user_id = CAST(:user AS uuid) AND is_primary"),
        {"user": user_id},
    ).scalar_one_or_none()


#: What a model writes for "no agent, the real portfolio" (measured: "None").
_PRIMARY_WORDS = {"", "none", "null", "main", "primary", "real"}


def _pick_agent(agents: list[Any], name: Any) -> Any | dict[str, Any]:
    """The named agent, the primary when no name is given, or an error naming the choices.

    An exact name (any case) wins; otherwise the one agent whose name contains it,
    so "Test" finds "Test agent" (measured 2026-10-12: a real model asked for
    "Test", found nothing, and its answer failed). Two that contain it are an
    error naming both, never a guess.
    """
    if name is None or (isinstance(name, str) and name.strip().lower() in _PRIMARY_WORDS):
        return next(agent for agent in agents if agent.is_primary)
    if isinstance(name, str):
        wanted = name.strip().lower()
        exact = [agent for agent in agents if agent.name.lower() == wanted]
        partial = [agent for agent in agents if wanted in agent.name.lower()]
        if len(exact) == 1 or len(partial) == 1:
            return (exact or partial)[0]
    return {"error": f"no one agent is named {name!r}; the agents are {[a.name for a in agents]}"}


def _agent_filter(connection: Connection, user_id: str, name: Any) -> str | dict[str, Any] | None:
    """The id to filter by for a named agent: None for no name, or `_pick_agent`'s error."""
    if name is None or (isinstance(name, str) and not name.strip()):
        return None
    picked = _pick_agent(_agents(connection, user_id), name)
    return picked if isinstance(picked, dict) else str(picked.id)


async def _prices(context: ToolContext, symbols: list[str]) -> dict[str, Any]:
    if not symbols:
        return {}
    quotes, _missing = await context.market.quotes(sorted(set(symbols)))
    return {quote.symbol: quote for quote in quotes}


# -- get_portfolio -------------------------------------------------------------


async def get_portfolio(context: ToolContext, arguments: Mapping[str, Any]) -> dict[str, Any]:
    with context.engine.connect() as connection:
        agents = _agents(connection, context.user_id)
        if not agents:
            return {"error": "this account has no portfolio yet"}
        agent = _pick_agent(agents, arguments.get("agent"))
        if isinstance(agent, dict):
            return agent
        snapshots = connection.execute(
            text(
                """
                SELECT as_of, total_minor, cost_minor, currency, holdings_count, priced_count,
                       degraded, breakdown
                  FROM portfolio_snapshots
                 WHERE agent_id = CAST(:agent AS uuid) AND user_id = CAST(:user AS uuid)
                   AND as_of >= CAST(:since AS date)
                 ORDER BY as_of DESC
                """
            ),
            {
                "agent": agent.id,
                "user": context.user_id,
                "since": (context.now - timedelta(days=45)).date(),
            },
        ).all()
        holdings = connection.execute(
            text(
                """
                SELECT i.symbol, i.currency, h.quantity, h.cost_basis_minor
                  FROM holdings h
                  JOIN instruments i ON i.id = h.instrument_id
                 WHERE h.agent_id = CAST(:agent AS uuid) AND h.user_id = CAST(:user AS uuid)
                 ORDER BY i.symbol
                """
            ),
            {"agent": agent.id, "user": context.user_id},
        ).all()
        cash = connection.execute(
            text(
                "SELECT balance_minor, currency FROM agent_cash "
                "WHERE agent_id = CAST(:agent AS uuid) AND user_id = CAST(:user AS uuid)"
            ),
            {"agent": agent.id, "user": context.user_id},
        ).one_or_none()

    quotes = await _prices(context, [row.symbol for row in holdings])
    latest = snapshots[0] if snapshots else None
    base = latest.currency if latest is not None else BASE_CURRENCY
    by_symbol = {
        entry["symbol"]: entry for entry in (latest.breakdown if latest is not None else []) or []
    }
    rows = []
    for row in holdings:
        quote = quotes.get(row.symbol)
        snap = by_symbol.get(row.symbol)
        day_change = _day_change_minor(Decimal(row.quantity), quote)
        rows.append(
            {
                "symbol": row.symbol,
                "quantity": _quantity(row.quantity),
                "cost_per_unit": (
                    money(row.cost_basis_minor, row.currency)
                    if row.cost_basis_minor is not None
                    else None
                ),
                "price": money(quote.price_minor, quote.currency) if quote else None,
                "currency": quote.currency if quote else row.currency,
                "day_change_percent": quote.day_change_pct if quote else None,
                "day_change": (
                    money(day_change, quote.currency)
                    if quote is not None and day_change is not None
                    else None
                ),
                "price_as_of": quote.as_of.isoformat() if quote else None,
                "delayed_minutes": quote.delay_seconds // 60 if quote else None,
                "value_in_base": (
                    money(int(snap["valueMinor"]), latest.currency)
                    if latest is not None and snap and snap.get("valueMinor") is not None
                    else None
                ),
                "share_of_total_percent": (
                    str(Decimal(str(snap["weightPct"])).quantize(Decimal("0.01")))
                    if snap is not None and snap.get("weightPct") is not None
                    else None
                ),
            }
        )

    answer: dict[str, Any] = {
        "portfolio": agent.name,
        "real": bool(agent.is_primary),
        "holdings": rows,
        "cash": money(cash.balance_minor, cash.currency) if cash else None,
        "link": "/" if agent.is_primary else f"/agents/{agent.id}",
    }
    if cash is None and agent.is_primary:
        # Measured 2026-10-12: with `cash: null` and nothing more, "how much cash
        # do I have?" was answered with a guess or not at all.
        answer["cash_note"] = (
            "the real portfolio keeps no cash balance in this app - it records holdings "
            "only; cash is kept only by simulated agents, as paper money of their own "
            "(get_agents gives each one's), never part of the real portfolio"
        )
    if holdings:
        answer["today"] = _today(
            [(row.symbol, Decimal(row.quantity), quotes.get(row.symbol)) for row in holdings],
            base,
        )
    unpriced = [row["symbol"] for row in rows if row["price"] is None]
    if unpriced:
        answer["unpriced"] = unpriced
    if not holdings:
        answer["note"] = "this portfolio has no holdings"
    if latest is not None:
        total = Decimal(latest.total_minor)
        answer["snapshot"] = {
            "as_of": latest.as_of.isoformat(),
            "total_value": money(latest.total_minor, latest.currency),
            "total_cost": money(latest.cost_minor, latest.currency),
            "gain_percent": _pct(total - Decimal(latest.cost_minor), Decimal(latest.cost_minor)),
            "priced": f"{latest.priced_count} of {latest.holdings_count} holdings",
            "change_percent": {
                label: _window_change(snapshots, latest, days)
                for label, days in RETURN_WINDOWS.items()
            },
            "note": (
                "total, value_in_base and share_of_total_percent are from the daily snapshot "
                "of that date; price and day_change_percent are live"
            ),
        }
        if latest.priced_count < latest.holdings_count:
            # Measured 2026-10-14: with `priced: "5 of 6"` beside the total, the
            # model gave the total as the whole portfolio and named LEU only for
            # today's change, three samples in three. The total now says it itself.
            # The snapshot lists an unpriced holding with no value; an older or
            # thinner breakdown may leave it out, so a held symbol it does not
            # value counts as missing too.
            valued = {
                entry["symbol"]
                for entry in latest.breakdown or []
                if entry.get("valueMinor") is not None
            }
            missing = [row.symbol for row in holdings if row.symbol not in valued]
            answer["snapshot"]["total_covers"] = (
                f"total_value and total_cost cover {latest.priced_count} of "
                f"{latest.holdings_count} holdings; "
                + (f"{', '.join(missing)} had no price and " if missing else "unpriced ones ")
                + "are not in them - say so wherever the total is given"
            )
    else:
        # The windows are named even when unknown, so "no 7-day figure yet" is a
        # statement about a window the evidence names, not an invented number.
        answer["snapshot"] = {
            "as_of": None,
            "total_value": None,
            "change_percent": dict.fromkeys(RETURN_WINDOWS),
            "note": "no daily snapshot of this portfolio exists yet, so its total is unknown",
        }
    return answer


def _day_change_minor(quantity: Decimal, quote: Any) -> int | None:
    """A holding's change since the previous close, in the quote's currency, rounded once."""
    if quote is None or quote.previous_close_minor is None:
        return None
    change = quantity * (Decimal(quote.price_minor) - Decimal(quote.previous_close_minor))
    return int(change.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _today(held: Sequence[tuple[str, Decimal, Any]], base: str) -> dict[str, Any]:
    """Today's change in money and percent, as the Portfolio page's summary has it:
    live prices against the previous close, summed over the holdings that have both.

    Only holdings quoted in the base currency are summed - this service converts
    no currency - and every holding left out is named, so a total over part of the
    portfolio is never read as the whole of it (guideline 7).
    """
    counted = [
        (quantity, quote)
        for _symbol, quantity, quote in held
        if quote is not None and quote.previous_close_minor is not None and quote.currency == base
    ]
    left_out = [
        symbol
        for symbol, _quantity, quote in held
        if quote is None or quote.previous_close_minor is None or quote.currency != base
    ]
    if not counted:
        return {
            "change": None,
            "change_percent": None,
            "note": f"no holding has a live price and a previous close in {base}",
        }
    now_value = sum((q * Decimal(quote.price_minor) for q, quote in counted), Decimal(0))
    previous = sum((q * Decimal(quote.previous_close_minor) for q, quote in counted), Decimal(0))
    change = int((now_value - previous).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    answer: dict[str, Any] = {
        "change": money(change, base),
        "change_percent": _pct(Decimal(change), previous),
        "covers": f"{len(counted)} of {len(held)} holdings",
    }
    if left_out:
        answer["left_out"] = left_out
        answer["note"] = (
            f"holdings that are unpriced, have no previous close, or are not quoted in {base} "
            "are left out of today's change"
        )
    return answer


def _window_change(snapshots: Sequence[Any], latest: Any, days: int) -> str | None:
    target = latest.as_of - timedelta(days=days)
    earlier = next((s for s in snapshots if s.as_of <= target), None)
    if earlier is None:
        return None
    return _pct(
        Decimal(latest.total_minor) - Decimal(earlier.total_minor), Decimal(earlier.total_minor)
    )


# -- get_agents ----------------------------------------------------------------


async def get_agents(context: ToolContext, arguments: Mapping[str, Any]) -> dict[str, Any]:
    with context.engine.connect() as connection:
        agents = _agents(connection, context.user_id)
        holdings = connection.execute(
            text(
                """
                SELECT h.agent_id::text AS agent_id, i.symbol, h.quantity
                  FROM holdings h JOIN instruments i ON i.id = h.instrument_id
                 WHERE h.user_id = CAST(:user AS uuid)
                """
            ),
            {"user": context.user_id},
        ).all()
        cash = {
            row.agent_id: row
            for row in connection.execute(
                text(
                    "SELECT agent_id::text AS agent_id, balance_minor, currency FROM agent_cash "
                    "WHERE user_id = CAST(:user AS uuid)"
                ),
                {"user": context.user_id},
            ).all()
        }
        spend = {
            row.agent_id: row
            for row in connection.execute(
                text(
                    """
                    SELECT agent_id::text AS agent_id,
                           coalesce(sum(cost_micro_usd) FILTER (WHERE started_at >= :today), 0)
                               AS today,
                           coalesce(sum(cost_micro_usd), 0) AS week
                      FROM llm_calls
                     WHERE user_id = CAST(:user AS uuid) AND purpose = 'agent_scan'
                       AND started_at >= :week
                     GROUP BY agent_id
                    """
                ),
                {
                    "user": context.user_id,
                    "today": start_of_utc_day(context.now),
                    "week": context.now - timedelta(days=7),
                },
            ).all()
        }
        scans = connection.execute(
            text(
                """
                SELECT DISTINCT ON (agent_id) agent_id::text AS agent_id, id::text AS id,
                       started_at, outcome, cost_micro_usd
                  FROM agent_scans
                 WHERE user_id = CAST(:user AS uuid)
                 ORDER BY agent_id, started_at DESC
                """
            ),
            {"user": context.user_id},
        ).all()
        month_start = _month_start(context.now)
        ledger = _ledger_at(connection, context.user_id, month_start)
    last_scan = {row.agent_id: row for row in scans}
    quotes = await _prices(context, [row.symbol for row in holdings])
    closes: dict[str, int | None] = {}

    listed = []
    for agent in agents:
        held = [row for row in holdings if row.agent_id == agent.id]
        entry: dict[str, Any] = {
            "name": agent.name,
            "real": bool(agent.is_primary),
            "state": agent.state,
            "holdings": [{"symbol": r.symbol, "quantity": _quantity(r.quantity)} for r in held],
            "link": "/" if agent.is_primary else f"/agents/{agent.id}",
        }
        if not agent.is_primary:
            simulated, worth_minor = _simulated(agent, held, cash.get(agent.id), quotes)
            entry.update(simulated)
            entry["month_to_date"] = await _month_to_date(
                context, agent, worth_minor, ledger, month_start, closes
            )
            spent = spend.get(agent.id)
            scan = last_scan.get(agent.id)
            entry.update(
                {
                    "persona": agent.persona,
                    "scan_schedule": agent.scan_schedule,
                    "next_scan": describe_next_scan(
                        schedule=agent.scan_schedule,
                        state=agent.state,
                        ready=ready_to_scan(agent.persona, agent.mandate_set),
                        scheduling=context.scheduling,
                        now=context.now,
                    ),
                    "model_budget_per_day_usd": _usd(agent.llm_budget_micro_usd),
                    "model_spend_today_usd": _usd(spent.today if spent else 0),
                    "model_spend_7d_usd": _usd(spent.week if spent else 0),
                    "last_scan": (
                        {
                            "scan_id": scan.id,
                            "started_at": scan.started_at.isoformat(),
                            "outcome": scan.outcome,
                            "cost_usd": _usd(scan.cost_micro_usd),
                        }
                        if scan
                        else None
                    ),
                }
            )
        listed.append(entry)
    return {
        "agents": listed,
        "note": (
            "model spend is recorded model cost in USD; a day is a UTC day. "
            "return_percent is since the agent started, against its paper budget. "
            "month_to_date is the change since the month began (UTC) with deposits taken "
            "out: net worth now against the value at the last close before `since` plus what "
            "was deposited after it; an agent started this month counts from its start, so "
            "every agent's month_to_date covers the same month. next_scan.local is the "
            "next scheduled scan in the user's time zone."
        ),
    }


def _usd(micro: int) -> str:
    return str((Decimal(micro) / Decimal(1_000_000)).quantize(Decimal("0.0001")))


def _simulated(
    agent: Any, held: list[Any], cash: Any, quotes: dict[str, Any]
) -> tuple[dict[str, Any], int | None]:
    """A simulated agent's paper net worth: cash plus holdings at live prices (USD only,
    D7) - as the answer reports it, and in minor units, None while anything is unpriced."""
    unpriced = [row.symbol for row in held if row.symbol not in quotes]
    cash_minor = cash.balance_minor if cash else 0
    answer: dict[str, Any] = {
        "paper_budget": money(agent.budget_minor or 0, agent.currency or "USD"),
        "cash": money(cash_minor, "USD"),
    }
    if unpriced:
        answer.update({"net_worth": None, "return_percent": None, "unpriced": unpriced})
        return answer, None
    worth = Decimal(cash_minor) + sum(
        (Decimal(row.quantity) * Decimal(quotes[row.symbol].price_minor) for row in held),
        Decimal(0),
    )
    worth_minor = int(worth.quantize(Decimal(1)))
    answer["net_worth"] = money(worth_minor, "USD")
    answer["return_percent"] = _pct(
        Decimal(worth_minor) - Decimal(agent.budget_minor or 0), Decimal(agent.budget_minor or 0)
    )
    return answer, worth_minor


def _month_start(now: datetime) -> datetime:
    return now.astimezone(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)


@dataclass(frozen=True)
class _LedgerAt:
    """Each agent's ledger at an instant: cash then, deposits since, shares held then."""

    existed: dict[str, bool]
    cash_then: dict[str, int]
    deposited_since: dict[str, int]
    held_then: dict[str, list[tuple[str, Decimal]]]


def _ledger_at(connection: Connection, user_id: str, at: datetime) -> _LedgerAt:
    """The ledger replayed to `at`, as the agent page's performance does it (D36):
    cash is every movement before it, holdings every fill before it."""
    movements = connection.execute(
        text(
            """
            SELECT agent_id::text AS agent_id,
                   bool_or(created_at < :at) AS existed,
                   coalesce(sum(amount_minor) FILTER (WHERE created_at < :at), 0) AS cash_then,
                   coalesce(sum(amount_minor) FILTER (
                       WHERE created_at >= :at AND kind IN ('opening_deposit', 'top_up')
                   ), 0) AS deposited_since
              FROM cash_movements
             WHERE user_id = CAST(:user AS uuid)
             GROUP BY agent_id
            """
        ),
        {"user": user_id, "at": at},
    ).all()
    fills = connection.execute(
        text(
            """
            SELECT f.agent_id::text AS agent_id, i.symbol,
                   sum(CASE WHEN f.side = 'buy' THEN f.quantity ELSE -f.quantity END) AS quantity
              FROM fills f JOIN instruments i ON i.id = f.instrument_id
             WHERE f.user_id = CAST(:user AS uuid) AND f.created_at < :at
             GROUP BY f.agent_id, i.symbol
            HAVING sum(CASE WHEN f.side = 'buy' THEN f.quantity ELSE -f.quantity END) <> 0
             ORDER BY i.symbol
            """
        ),
        {"user": user_id, "at": at},
    ).all()
    held: dict[str, list[tuple[str, Decimal]]] = {}
    for row in fills:
        held.setdefault(row.agent_id, []).append((row.symbol, Decimal(row.quantity)))
    return _LedgerAt(
        existed={row.agent_id: bool(row.existed) for row in movements},
        cash_then={row.agent_id: int(row.cash_then) for row in movements},
        deposited_since={row.agent_id: int(row.deposited_since) for row in movements},
        held_then=held,
    )


async def _close_before(context: ToolContext, symbol: str, at: datetime) -> int | None:
    """The last stored close before `at`, within `MONTH_START_CLOSE_DAYS`; None when none is."""
    listing = find_listing(context.engine, symbol)
    if listing is None:
        return None
    span = (context.now - at).days + MONTH_START_CLOSE_DAYS
    points = await _stored_closes(context, listing, span)
    earliest = at - timedelta(days=MONTH_START_CLOSE_DAYS)
    before = [point for point in points if earliest <= point.as_of < at]
    return before[-1].price_minor if before else None


async def _month_to_date(
    context: ToolContext,
    agent: Any,
    worth_minor: int | None,
    ledger: _LedgerAt,
    month_start: datetime,
    closes: dict[str, int | None],
) -> dict[str, Any]:
    """The agent's change this month, deposits taken out (measured 2026-10-12: with
    only each agent's return since its own start, "which agent did best this month?"
    compared two different periods). Unavailable, never partial (decision 111)."""
    existed = ledger.existed.get(agent.id, False)
    since = month_start if existed else agent.created_at
    answer: dict[str, Any] = {"since": since.date().isoformat()}
    if worth_minor is None:
        return {**answer, "change": None, "change_percent": None, "note": "a holding is unpriced"}
    start_value = Decimal(ledger.cash_then.get(agent.id, 0)) if existed else Decimal(0)
    for symbol, quantity in ledger.held_then.get(agent.id, []) if existed else []:
        if symbol not in closes:
            closes[symbol] = await _close_before(context, symbol, month_start)
        close = closes[symbol]
        if close is None:
            return {
                **answer,
                "change": None,
                "change_percent": None,
                "note": f"no close of {symbol} before {since.date().isoformat()} is stored",
            }
        start_value += quantity * Decimal(close)
    start_minor = int(start_value.quantize(Decimal(1), rounding=ROUND_HALF_UP))
    deposited = ledger.deposited_since.get(agent.id, 0)
    change = worth_minor - start_minor - deposited
    return {
        **answer,
        "value_at_start": money(start_minor, "USD"),
        "deposited_since": money(deposited, "USD"),
        "change": money(change, "USD"),
        "change_percent": _pct(Decimal(change), Decimal(start_minor + deposited)),
    }


# -- get_proposals -------------------------------------------------------------


async def get_proposals(context: ToolContext, arguments: Mapping[str, Any]) -> dict[str, Any]:
    state = arguments.get("state", "pending")
    if state not in (*PROPOSAL_STATES, "any"):
        return {"error": f"state is one of {[*PROPOSAL_STATES, 'any']}"}
    limit = _limit(arguments)
    if limit is None:
        return {"error": f"limit is a whole number from 1 to {MAX_ROWS}"}
    symbol = arguments.get("symbol")
    symbol = symbol.strip().upper() if isinstance(symbol, str) and symbol.strip() else None
    with context.engine.connect() as connection:
        agent = _agent_filter(connection, context.user_id, arguments.get("agent"))
        if isinstance(agent, dict):
            return agent
        rows = connection.execute(
            text(
                """
                WITH current AS (
                    SELECT p.*,
                           CASE
                             WHEN p.state IN ('pending', 'snoozed') AND p.expires_at <= :now
                               THEN 'expired'
                             WHEN p.state = 'snoozed' AND p.snoozed_until <= :now THEN 'pending'
                             ELSE p.state
                           END AS current_state
                      FROM proposals p
                     WHERE p.user_id = CAST(:user AS uuid)
                )
                SELECT c.id::text AS id, c.kind, c.current_state, c.payload, c.created_at,
                       c.expires_at, c.decided_at, c.decided_via,
                       o.headline, o.subject_ref, a.name AS agent, a.is_primary,
                       s.answer ->> 'thesis' AS thesis, c.scan_id::text AS scan_id
                  FROM current c
                  JOIN observations o ON o.id = c.observation_id
                  JOIN agents a ON a.id = c.agent_id
                  LEFT JOIN agent_scans s ON s.id = c.scan_id
                 WHERE (:state = 'any' OR c.current_state = :state)
                   AND (CAST(:agent AS text) IS NULL OR a.id::text = :agent)
                   AND (CAST(:symbol AS text) IS NULL
                        OR c.payload ->> 'symbol' = :symbol
                        OR o.subject_ref = 'instrument:' || :symbol)
                 ORDER BY c.created_at DESC
                 LIMIT :limit
                """
            ),
            {
                "user": context.user_id,
                "now": context.now,
                "state": state,
                "agent": agent,
                "symbol": symbol,
                "limit": limit,
            },
        ).all()
    proposals = []
    for row in rows:
        entry: dict[str, Any] = {
            "id": row.id,
            "kind": row.kind,
            "state": row.current_state,
            "agent": row.agent,
            "real_portfolio": bool(row.is_primary),
            "headline": row.headline,
            "created_at": row.created_at.isoformat(),
            "expires_at": row.expires_at.isoformat(),
            "decided_at": row.decided_at.isoformat() if row.decided_at else None,
            "link": f"/proposals/{row.id}",
        }
        payload = row.payload if isinstance(row.payload, dict) else {}
        if row.kind in ("buy", "sell") and payload:
            entry["trade"] = {
                "symbol": payload.get("symbol"),
                "quantity": payload.get("quantity"),
                "agent_price": (
                    money(int(payload["priceMinor"]), payload.get("currency", "USD"))
                    if payload.get("priceMinor") is not None
                    else None
                ),
                "price_as_of": payload.get("priceAsOf"),
            }
            entry["thesis"] = row.thesis
            entry["scan_id"] = row.scan_id
        proposals.append(entry)
    return {
        "state": state,
        "proposals": proposals,
        **({} if proposals else {"note": f"no {state} proposals match"}),
    }


# -- get_observations ----------------------------------------------------------


async def get_observations(context: ToolContext, arguments: Mapping[str, Any]) -> dict[str, Any]:
    days = arguments.get("days", DEFAULT_OBSERVATION_DAYS)
    if not isinstance(days, int) or not 1 <= days <= MAX_OBSERVATION_DAYS:
        return {"error": f"days is a whole number from 1 to {MAX_OBSERVATION_DAYS}"}
    limit = _limit(arguments)
    if limit is None:
        return {"error": f"limit is a whole number from 1 to {MAX_ROWS}"}
    kind = arguments.get("kind")
    kind = kind.strip() if isinstance(kind, str) and kind.strip() else None
    symbol = arguments.get("symbol")
    symbol = symbol.strip().upper() if isinstance(symbol, str) and symbol.strip() else None
    with context.engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                SELECT o.id::text AS id, o.kind, o.severity, o.subject_ref, o.headline,
                       o.explanation, o.evidence, o.created_at, a.name AS agent, a.is_primary
                  FROM observations o
                  LEFT JOIN agents a ON a.id = o.agent_id
                 WHERE o.user_id = CAST(:user AS uuid)
                   AND o.created_at >= :since
                   AND (CAST(:kind AS text) IS NULL OR o.kind = :kind)
                   AND (CAST(:symbol AS text) IS NULL OR o.subject_ref = 'instrument:' || :symbol)
                 ORDER BY o.created_at DESC
                 LIMIT :limit
                """
            ),
            {
                "user": context.user_id,
                "since": context.now - timedelta(days=days),
                "kind": kind,
                "symbol": symbol,
                "limit": limit,
            },
        ).all()
    return {
        "days": days,
        "observations": [
            {
                "id": row.id,
                "kind": row.kind,
                "severity": row.severity,
                "subject": row.subject_ref,
                "portfolio": row.agent if row.agent else None,
                "headline": row.headline,
                "explanation": row.explanation,
                "evidence": row.evidence,
                "created_at": row.created_at.isoformat(),
                "link": "/insights",
            }
            for row in rows
        ],
        "note": (
            "severity comes from the size of the finding against the thresholds in its "
            "evidence, never from a model"
        ),
    }


# -- get_topics ----------------------------------------------------------------


async def get_topics(context: ToolContext, arguments: Mapping[str, Any]) -> dict[str, Any]:
    wanted = arguments.get("topic")
    wanted = wanted.strip().lower() if isinstance(wanted, str) and wanted.strip() else None
    with context.engine.connect() as connection:
        topics = connection.execute(
            text(
                """
                SELECT t.id::text AS id, t.label, t.confirmed_at
                  FROM topics t
                 WHERE t.user_id = CAST(:user AS uuid) AND t.status = 'active'
                 ORDER BY t.confirmed_at DESC NULLS LAST, t.label
                """
            ),
            {"user": context.user_id},
        ).all()
        if wanted is not None:
            topics = [t for t in topics if wanted in t.label.lower()] or []
        answer = []
        for topic in topics:
            instruments = connection.execute(
                text(
                    """
                    SELECT i.symbol, i.name, ti.source, ti.confidence, ti.rationale, ti.held_by
                      FROM topic_instruments ti JOIN instruments i ON i.id = ti.instrument_id
                     WHERE ti.topic_id = CAST(:topic AS uuid) AND ti.user_id = CAST(:user AS uuid)
                     ORDER BY i.symbol
                     LIMIT :limit
                    """
                ),
                {"topic": topic.id, "user": context.user_id, "limit": MAX_TOPIC_INSTRUMENTS},
            ).all()
            move = connection.execute(
                text(
                    """
                    SELECT headline, severity, evidence, created_at
                      FROM observations
                     WHERE user_id = CAST(:user AS uuid) AND kind = 'topic_move'
                       AND subject_ref = 'topic:' || :topic
                     ORDER BY created_at DESC
                     LIMIT 1
                    """
                ),
                {"topic": topic.id, "user": context.user_id},
            ).one_or_none()
            answer.append(
                {
                    "topic": topic.label,
                    "confirmed_at": topic.confirmed_at.isoformat() if topic.confirmed_at else None,
                    "instruments": [
                        {
                            "symbol": row.symbol,
                            "name": row.name,
                            "matched_by": row.source,
                            "confidence": row.confidence,
                            "reason": row.rationale,
                            "held_by": row.held_by,
                        }
                        for row in instruments
                    ],
                    "latest_move": (
                        {
                            "headline": move.headline,
                            "severity": move.severity,
                            "evidence": move.evidence,
                            "at": move.created_at.isoformat(),
                        }
                        if move
                        else None
                    ),
                }
            )
    return {
        "topics": answer,
        "link": "/topics",
        **(
            {}
            if answer
            else {"note": "no followed topic matches" if wanted else "no topics are followed"}
        ),
    }


# -- get_product_guide ---------------------------------------------------------


async def get_product_guide(context: ToolContext, arguments: Mapping[str, Any]) -> dict[str, Any]:
    section = arguments.get("section")
    if section is None:
        return {"sections": dict(SECTIONS)}
    if section not in SECTIONS:
        return {"error": f"section is one of {list(SECTIONS)}, or omit it for all"}
    return {section: SECTIONS[section]}


# -- replay_scan ---------------------------------------------------------------

#: A step's tool result is cut here: enough to see what the agent read and the
#: figures its thesis quotes, short enough that a twelve-step scan stays cheap
#: to re-read. Every figure inside the kept part is evidence like any other.
MAX_STEP_RESULT_CHARS = 1200
#: Scans listed when the model asks which scan it should replay.
MAX_SCANS_LISTED = 10


def _compact(value: Any) -> Any:
    raw = json.dumps(value, ensure_ascii=False, default=str)
    if len(raw) <= MAX_STEP_RESULT_CHARS:
        return value
    return {"truncated": raw[:MAX_STEP_RESULT_CHARS] + "…", "full_length": len(raw)}


async def replay_scan(context: ToolContext, arguments: Mapping[str, Any]) -> dict[str, Any]:
    """One recorded scan step by step (MEMORY.md, added 2026-10-11): what the agent
    was briefed with, each tool it called with what came back, and what it decided."""
    scan_id = arguments.get("scan_id")
    agent = arguments.get("agent")
    symbol = arguments.get("symbol")
    scan_id = scan_id.strip() if isinstance(scan_id, str) and scan_id.strip() else None
    symbol = symbol.strip().upper() if isinstance(symbol, str) and symbol.strip() else None
    with context.engine.connect() as connection:
        agent = _agent_filter(connection, context.user_id, agent)
        if isinstance(agent, dict):
            return agent
        rows = connection.execute(
            text(
                """
                SELECT s.id::text AS id, a.id::text AS agent_id, a.name AS agent, s.trigger,
                       s.started_at, s.finished_at, s.outcome, s.steps, s.cost_micro_usd, s.model,
                       s.briefing, s.transcript, s.answer, s.error
                  FROM agent_scans s
                  JOIN agents a ON a.id = s.agent_id
                 WHERE s.user_id = CAST(:user AS uuid)
                   AND (CAST(:scan AS text) IS NULL OR s.id::text = :scan)
                   AND (CAST(:agent AS text) IS NULL OR a.id::text = :agent)
                   AND (CAST(:symbol AS text) IS NULL OR s.answer ->> 'symbol' = :symbol)
                 ORDER BY s.started_at DESC
                 LIMIT :limit
                """
            ),
            {
                "user": context.user_id,
                "scan": scan_id,
                "agent": agent,
                "symbol": symbol,
                "limit": MAX_SCANS_LISTED,
            },
        ).all()
    if not rows:
        return {"note": "no recorded scan matches", "scans": []}
    scan = rows[0]
    briefing = scan.briefing if isinstance(scan.briefing, dict) else {}
    steps: list[dict[str, Any]] = []
    calls: dict[str, dict[str, Any]] = {}
    for entry in scan.transcript if isinstance(scan.transcript, list) else []:
        if entry.get("role") == "assistant":
            for call in entry.get("tool_calls", []):
                step = {"step": len(steps) + 1, "tool": call.get("name"), "arguments": None}
                try:
                    step["arguments"] = json.loads(call.get("arguments") or "{}")
                except json.JSONDecodeError:
                    step["arguments"] = call.get("arguments")
                calls[str(call.get("id"))] = step
                steps.append(step)
        elif entry.get("role") == "tool":
            answered = calls.get(str(entry.get("call_id")))
            if answered is not None:
                answered["result"] = _compact(entry.get("result"))
    answer = scan.answer if isinstance(scan.answer, dict) else None
    return {
        "scan_id": scan.id,
        "agent": scan.agent,
        "trigger": scan.trigger,
        "started_at": scan.started_at.isoformat(),
        "finished_at": scan.finished_at.isoformat() if scan.finished_at else None,
        "outcome": scan.outcome,
        "model": scan.model,
        "cost_usd": _usd(scan.cost_micro_usd),
        "briefing": {
            "cash": briefing.get("cash"),
            "holdings": [h.get("symbol") for h in briefing.get("holdings", [])],
            "movers": {
                kind: [m.get("symbol") for m in listed]
                for kind, listed in (briefing.get("movers") or {}).items()
                if isinstance(listed, list)
            },
            "followed_topics": briefing.get("followed_topics", []),
        },
        "steps": steps,
        "decision": answer,
        "scan_error": scan.error,
        "link": f"/agents/{scan.agent_id}",
        **(
            {
                "other_matching_scans": [
                    {
                        "scan_id": r.id,
                        "agent": r.agent,
                        "started_at": r.started_at.isoformat(),
                        "outcome": r.outcome,
                    }
                    for r in rows[1:]
                ]
            }
            if len(rows) > 1
            else {}
        ),
        "note": (
            "outcomes: trade (a proposal was made), no_trade, invalid_answer (the answer failed "
            "the server's checks, so nothing was proposed), rule_rejected (the trade broke the "
            "agent's mandate twice, so nothing was proposed), budget_reached, step_limit, failed"
        ),
    }


# -- get_universe_info ---------------------------------------------------------

#: The orchestrator rescreens when the loaded snapshot is this old
#: (`services/universeRescreen.ts`, decision 90); a test holds the two equal.
RESCREEN_DUE_DAYS = 91


async def get_universe_info(context: ToolContext, arguments: Mapping[str, Any]) -> dict[str, Any]:
    """The universe as loaded: when it was screened, by what rule, what it holds, and
    whether a symbol is in it (MEMORY.md, added 2026-10-11)."""
    symbol = arguments.get("symbol")
    symbol = symbol.strip().upper() if isinstance(symbol, str) and symbol.strip() else None
    with context.engine.connect() as connection:
        load = connection.execute(
            text(
                "SELECT snapshot_as_of, source, manifest, loaded_at FROM universe_loads "
                "ORDER BY loaded_at DESC LIMIT 1"
            )
        ).one_or_none()
        membership: dict[str, int] = {
            row.membership: int(row.members)
            for row in connection.execute(
                text(
                    "SELECT membership, count(*) AS members FROM instrument_profiles "
                    "GROUP BY membership"
                )
            ).all()
        }
        rescreen = connection.execute(
            text(
                """
                SELECT started_at, finished_at, stats FROM runs
                 WHERE kind = 'universe_rescreen' AND status = 'ok'
                 ORDER BY started_at DESC LIMIT 1
                """
            )
        ).one_or_none()
        dropped = list(
            connection.execute(
                text(
                    "SELECT i.symbol FROM instrument_profiles p "
                    "JOIN instruments i ON i.id = p.instrument_id "
                    "WHERE p.membership = 'dropped' ORDER BY i.symbol LIMIT 50"
                )
            ).scalars()
        )
        lookup = (
            connection.execute(
                text(
                    """
                    SELECT i.symbol, i.name, i.asset_class, i.currency, p.membership,
                           p.market_cap_minor, p.net_assets_minor, p.size_currency
                      FROM instruments i
                      LEFT JOIN instrument_profiles p ON p.instrument_id = i.id
                     WHERE i.symbol = :symbol
                    """
                ),
                {"symbol": symbol},
            ).one_or_none()
            if symbol
            else None
        )
    if load is None:
        return {"note": "no universe has been loaded on this installation"}
    manifest = load.manifest if isinstance(load.manifest, dict) else {}
    screen = manifest.get("screen", {})
    size_currency = screen.get("min_size_currency", "USD")
    answer: dict[str, Any] = {
        "screened_at": load.snapshot_as_of.isoformat(),
        "loaded_at": load.loaded_at.isoformat(),
        "source": manifest.get("source") or load.source,
        "rules": {
            "region": screen.get("region"),
            "exchanges": screen.get("exchanges"),
            "min_stock_market_cap": (
                money(int(screen["min_equity_size_minor"]), size_currency)
                if screen.get("min_equity_size_minor") is not None
                else None
            ),
            "min_etf_net_assets": (
                money(int(screen["min_etf_size_minor"]), size_currency)
                if screen.get("min_etf_size_minor") is not None
                else None
            ),
            "size_currency": size_currency,
        },
        "counts": manifest.get("counts", {}),
        "membership": membership,
        "rescreen_every_days": RESCREEN_DUE_DAYS,
        "last_rescreen": (
            {
                "at": rescreen.started_at.isoformat(),
                "created": (rescreen.stats or {}).get("created"),
                "dropped": (rescreen.stats or {}).get("dropped"),
            }
            if rescreen
            else None
        ),
        "dropped_symbols": dropped,
        "note": (
            "membership: screened (passed the screen), on_demand (outside it, profiled because "
            "a user named it), dropped (left at a rescreen; kept so history still resolves)"
        ),
    }
    if symbol:
        if lookup is None:
            answer["symbol"] = {"symbol": symbol, "known": False}
        else:
            size = lookup.market_cap_minor or lookup.net_assets_minor
            answer["symbol"] = {
                "symbol": lookup.symbol,
                "known": True,
                "name": lookup.name,
                "kind": lookup.asset_class,
                "membership": lookup.membership or "not_profiled",
                "size": money(int(size), lookup.size_currency)
                if size and lookup.size_currency
                else None,
            }
    return answer


# -- the set -------------------------------------------------------------------

_TEXT = {"type": "string"}
_LIMIT = {"type": "integer", "minimum": 1, "maximum": MAX_ROWS}

OWN_TOOLS: tuple[Tool, ...] = (
    Tool(
        ToolSpec(
            "get_portfolio",
            "The user's real portfolio, or a named agent's: holdings with live (delayed) "
            "prices and today's change in money and percent, the whole portfolio's change "
            "today, value and weight from the daily snapshot, cash (the real portfolio keeps "
            "none), and the total's change over 1, 7 and 30 days.",
            _object({"agent": _TEXT}, []),
        ),
        get_portfolio,
    ),
    Tool(
        ToolSpec(
            "get_agents",
            "The user's agents: real or simulated, state, persona, holdings, paper cash, net "
            "worth, return since start and this month, scan schedule and when the next "
            "scheduled scan is, model budget and spend, and each one's last scan.",
            _object({}, []),
        ),
        get_agents,
    ),
    Tool(
        ToolSpec(
            "get_proposals",
            "Proposals the user is or was asked to decide, newest first, with each trade's "
            "thesis. state defaults to pending; use 'any' for all.",
            _object(
                {
                    "state": {"type": "string", "enum": [*PROPOSAL_STATES, "any"]},
                    "agent": _TEXT,
                    "symbol": _TEXT,
                    "limit": _LIMIT,
                },
                [],
            ),
        ),
        get_proposals,
    ),
    Tool(
        ToolSpec(
            "get_observations",
            "What the rules found for this user (price moves, drawdowns, drift, topic moves), "
            "newest first, with the evidence and thresholds behind each severity.",
            _object(
                {
                    "days": {"type": "integer", "minimum": 1, "maximum": MAX_OBSERVATION_DAYS},
                    "kind": _TEXT,
                    "symbol": _TEXT,
                    "limit": _LIMIT,
                },
                [],
            ),
        ),
        get_observations,
    ),
    Tool(
        ToolSpec(
            "get_topics",
            "The topics the user follows: each one's instruments with why each matched, and "
            "its latest move.",
            _object({"topic": _TEXT}, []),
        ),
        get_topics,
    ),
    Tool(
        ToolSpec(
            "replay_scan",
            "One recorded agent scan, step by step: its briefing, each tool it called with "
            "what came back, and its decision or why it made none. Picks the latest scan "
            "matching scan_id, agent and/or the symbol it decided on.",
            _object({"scan_id": _TEXT, "agent": _TEXT, "symbol": _TEXT}, []),
        ),
        replay_scan,
    ),
    Tool(
        ToolSpec(
            "get_universe_info",
            "The universe - in this app, the set of US stocks and ETFs it knows, never the "
            "cosmos: how it was made (the screen's source and rules), when it was screened and "
            "loaded, its counts, how often it is rescreened, the last rescreen and what it "
            "dropped, and - given a symbol - whether that symbol is in it.",
            _object({"symbol": _TEXT}, []),
        ),
        get_universe_info,
    ),
    Tool(
        ToolSpec(
            "get_product_guide",
            "How this app works: its pages, a typical workflow, topics, agents and their "
            "tools, the evidence check, proposals, Telegram, settings, the universe, and what "
            "this assistant can and cannot do.",
            _object({"section": {"type": "string", "enum": list(SECTIONS)}}, []),
        ),
        get_product_guide,
    ),
)

TOOLS: tuple[Tool, ...] = (*(AGENT_TOOLS[name] for name in SHARED), *OWN_TOOLS)
TOOLS_BY_NAME: dict[str, Tool] = {tool.spec.name: tool for tool in TOOLS}
