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

from collections.abc import Mapping, Sequence
from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.agents.scan_budget import start_of_utc_day
from app.agents.tools import TOOLS_BY_NAME as AGENT_TOOLS
from app.agents.tools import Tool, ToolContext, _object, money
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
                SELECT id::text AS id, name, is_primary, state, persona, scan_schedule,
                       budget_minor, currency, llm_budget_micro_usd, created_at
                  FROM agents
                 WHERE user_id = CAST(:user AS uuid)
                 ORDER BY is_primary DESC, created_at
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
    """The named agent, the primary when no name is given, or an error naming the choices."""
    if name is None or (isinstance(name, str) and name.strip().lower() in _PRIMARY_WORDS):
        return next(agent for agent in agents if agent.is_primary)
    if isinstance(name, str):
        for agent in agents:
            if agent.name.lower() == name.strip().lower():
                return agent
    return {"error": f"no agent named {name!r}; the agents are {[a.name for a in agents]}"}


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
    by_symbol = {
        entry["symbol"]: entry for entry in (latest.breakdown if latest is not None else []) or []
    }
    rows = []
    for row in holdings:
        quote = quotes.get(row.symbol)
        snap = by_symbol.get(row.symbol)
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
                "price_as_of": quote.as_of.isoformat() if quote else None,
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
    last_scan = {row.agent_id: row for row in scans}
    quotes = await _prices(context, [row.symbol for row in holdings])

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
            entry.update(_simulated(agent, held, cash.get(agent.id), quotes))
            spent = spend.get(agent.id)
            scan = last_scan.get(agent.id)
            entry.update(
                {
                    "persona": agent.persona,
                    "scan_schedule": agent.scan_schedule,
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
            "return_percent is since the agent started, against its paper budget."
        ),
    }


def _usd(micro: int) -> str:
    return str((Decimal(micro) / Decimal(1_000_000)).quantize(Decimal("0.0001")))


def _simulated(agent: Any, held: list[Any], cash: Any, quotes: dict[str, Any]) -> dict[str, Any]:
    """A simulated agent's paper net worth: cash plus holdings at live prices (USD only, D7)."""
    unpriced = [row.symbol for row in held if row.symbol not in quotes]
    cash_minor = cash.balance_minor if cash else 0
    answer: dict[str, Any] = {
        "paper_budget": money(agent.budget_minor or 0, agent.currency or "USD"),
        "cash": money(cash_minor, "USD"),
    }
    if unpriced:
        answer.update({"net_worth": None, "return_percent": None, "unpriced": unpriced})
        return answer
    worth = Decimal(cash_minor) + sum(
        (Decimal(row.quantity) * Decimal(quotes[row.symbol].price_minor) for row in held),
        Decimal(0),
    )
    worth_minor = int(worth.quantize(Decimal(1)))
    answer["net_worth"] = money(worth_minor, "USD")
    answer["return_percent"] = _pct(
        Decimal(worth_minor) - Decimal(agent.budget_minor or 0), Decimal(agent.budget_minor or 0)
    )
    return answer


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
    agent = arguments.get("agent")
    agent = agent.strip() if isinstance(agent, str) and agent.strip() else None
    with context.engine.connect() as connection:
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
                   AND (CAST(:agent AS text) IS NULL OR lower(a.name) = lower(:agent))
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


# -- the set -------------------------------------------------------------------

_TEXT = {"type": "string"}
_LIMIT = {"type": "integer", "minimum": 1, "maximum": MAX_ROWS}

OWN_TOOLS: tuple[Tool, ...] = (
    Tool(
        ToolSpec(
            "get_portfolio",
            "The user's real portfolio, or a named agent's: holdings with live prices and "
            "today's change, value and weight from the daily snapshot, cash, and the total's "
            "change over 1, 7 and 30 days.",
            _object({"agent": _TEXT}, []),
        ),
        get_portfolio,
    ),
    Tool(
        ToolSpec(
            "get_agents",
            "The user's agents: real or simulated, state, persona, holdings, paper net worth "
            "and return, scan schedule, model budget and spend, and each one's last scan.",
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
