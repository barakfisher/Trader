"""The read-only tools an agent's scan may call (D15).

Each wraps a component the product already has - topic resolution, the market
data registry, the analysis rules, the news store, the ledger, the concept
corpus - and answers with compact JSON the model reads and the evidence
validator later checks the thesis against (§6.2). **No tool writes anything a
user owns**: the scan's only output is its answer, which the server validates
(D14). The one write any tool makes is the price store's - `get_price_history`
backfills closes for an instrument nobody has looked at yet - which is the same
shared cache a chart fills, and decides nothing.

A tool never raises for something the model got wrong (an unknown symbol, too
many symbols): it answers `{"error": ...}`, so the model can correct itself
within its step limit. A failure of ours (the database, a provider) does raise,
and the scan records it.

Money leaves here as decimal strings in the instrument's currency ("182.40"):
the form a thesis will quote it in, and the form the validator matches. Never a
float, never minor units the model would have to divide (guideline 3).
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.analysis.backfill import backfill_history
from app.analysis.drawdown import drawdown_findings
from app.analysis.price_move import price_move_findings
from app.analysis.quote_history import load_daily_closes, load_price_series
from app.analysis.sigma_move import sigma_move_findings
from app.analysis.thresholds import AnalysisThresholds
from app.core.money import from_minor
from app.corpus.embeddings import BaseEmbedder
from app.corpus.retrieval import hybrid_search
from app.corpus.vector_store import VectorStore
from app.llm.base import ToolSpec
from app.models import BackfillInstrument
from app.providers.registry import MarketDataService
from app.topics.resolution import resolve_topic

#: Symbols one `get_quote` may ask for: enough to compare a few names, few
#: enough that a quote request stays one cheap call.
MAX_QUOTE_SYMBOLS = 5
#: The longest history a tool returns; the backfill stores about a year.
MAX_HISTORY_DAYS = 365
DEFAULT_HISTORY_DAYS = 90
#: Points in a history answer: weekly beyond this, so a year is ~52 rows, not 252.
MAX_HISTORY_POINTS = 60
#: How far back the findings rules look, as the portfolio scan does.
FINDINGS_DAYS = 120
MAX_NEWS_DAYS = 7
DEFAULT_NEWS_DAYS = 3
MAX_NEWS_ARTICLES = 8
MAX_SEARCH_RESULTS = 10
MAX_CONCEPT_CHUNKS = 2
#: A concept excerpt is cut here: enough to define a term, not a chapter.
MAX_CONCEPT_CHARS = 1200
#: Fewer stored closes than this and a history or findings call backfills first.
MIN_STORED_CLOSES = 20


@dataclass(frozen=True)
class ToolContext:
    """What the tools reach, scoped to one agent's scan."""

    engine: Engine
    market: MarketDataService
    embedder: BaseEmbedder
    vector_store: VectorStore
    thresholds: AnalysisThresholds
    excluded_price_sources: tuple[str, ...]
    user_id: str
    agent_id: str
    now: datetime


Handler = Callable[[ToolContext, Mapping[str, Any]], Awaitable[dict[str, Any]]]


@dataclass(frozen=True)
class Tool:
    spec: ToolSpec
    handler: Handler


def money(minor: int, currency: str) -> str:
    """Minor units as the decimal string a thesis would quote."""
    return str(from_minor(minor, currency))


def _symbol(arguments: Mapping[str, Any], key: str = "symbol") -> str | None:
    value = arguments.get(key)
    return value.strip().upper() if isinstance(value, str) and value.strip() else None


@dataclass(frozen=True)
class Listing:
    instrument_id: str
    symbol: str
    name: str | None
    currency: str
    exchange: str | None
    tradable: bool


def find_listing(engine: Engine, symbol: str) -> Listing | None:
    """An instrument and whether an agent may trade it - the rule
    `services/fills.ts:resolveTradable` applies: in the universe (not dropped) and
    priced in USD (D7, D8). The server re-checks it when a proposal is written."""
    with engine.connect() as connection:
        row = connection.execute(
            text(
                """
                SELECT i.id::text AS id, i.symbol, i.name, i.currency, i.exchange, p.membership
                  FROM instruments i
                  LEFT JOIN instrument_profiles p ON p.instrument_id = i.id
                 WHERE i.symbol = :symbol
                """
            ),
            {"symbol": symbol},
        ).one_or_none()
    if row is None:
        return None
    return Listing(
        instrument_id=row.id,
        symbol=row.symbol,
        name=row.name,
        currency=row.currency,
        exchange=row.exchange,
        tradable=row.membership not in (None, "dropped") and row.currency.upper() == "USD",
    )


def _unknown(symbol: str) -> dict[str, Any]:
    return {"error": f"{symbol} is not an instrument this system knows; try search_universe"}


# -- search_universe -----------------------------------------------------------


async def search_universe(context: ToolContext, arguments: Mapping[str, Any]) -> dict[str, Any]:
    query = arguments.get("query")
    if not isinstance(query, str) or not query.strip():
        return {"error": "query is a short description, e.g. 'gene editing' or 'regional banks'"}
    with context.engine.connect() as connection:
        resolution = await resolve_topic(connection, context.embedder, query.strip())
    candidates = [
        candidate
        for interpretation in resolution.interpretations
        for candidate in interpretation.candidates
    ][:MAX_SEARCH_RESULTS]
    return {
        "query": query.strip(),
        "matches": [
            {
                "symbol": candidate.symbol,
                "name": candidate.name,
                "kind": candidate.asset_class,
                "industry": candidate.industry,
                "confidence": candidate.confidence,
            }
            for candidate in candidates
        ],
        **({} if candidates else {"note": "nothing in the universe matches this closely"}),
    }


# -- get_quote -----------------------------------------------------------------


async def get_quote(context: ToolContext, arguments: Mapping[str, Any]) -> dict[str, Any]:
    raw = arguments.get("symbols")
    if not isinstance(raw, list) or not raw or not all(isinstance(s, str) for s in raw):
        return {"error": "symbols is a list of one to five tickers"}
    symbols = list(dict.fromkeys(s.strip().upper() for s in raw if s.strip()))
    if len(symbols) > MAX_QUOTE_SYMBOLS:
        return {"error": f"at most {MAX_QUOTE_SYMBOLS} symbols per call"}
    quotes, missing = await context.market.quotes(symbols)
    answer: dict[str, Any] = {}
    for quote in quotes:
        listing = find_listing(context.engine, quote.symbol)
        answer[quote.symbol] = {
            "price": money(quote.price_minor, quote.currency),
            "currency": quote.currency,
            "previous_close": (
                money(quote.previous_close_minor, quote.currency)
                if quote.previous_close_minor is not None
                else None
            ),
            "day_change_pct": quote.day_change_pct,
            "as_of": quote.as_of.isoformat(),
            "delayed_minutes": quote.delay_seconds // 60,
            "tradable": bool(listing and listing.tradable),
        }
    return {"quotes": answer, **({"unpriced": missing} if missing else {})}


# -- get_price_history ---------------------------------------------------------


async def _stored_closes(context: ToolContext, listing: Listing, days: int) -> list[Any]:
    """Stored closes, backfilled first when fewer than a few weeks are held."""

    def load() -> list[Any]:
        with context.engine.connect() as connection:
            return load_daily_closes(
                connection,
                listing.instrument_id,
                days=days,
                now=context.now,
                excluded_sources=context.excluded_price_sources,
            )

    points = load()
    if len(points) < MIN_STORED_CLOSES:
        with context.engine.begin() as connection:
            await backfill_history(
                connection,
                context.market,
                [BackfillInstrument(instrument_id=listing.instrument_id, symbol=listing.symbol)],
                max(days, FINDINGS_DAYS),
                now=context.now,
            )
        points = load()
    return points


def _change_pct(start: int, end: int) -> str:
    return str(((Decimal(end) - Decimal(start)) / Decimal(start) * 100).quantize(Decimal("0.01")))


async def get_price_history(context: ToolContext, arguments: Mapping[str, Any]) -> dict[str, Any]:
    symbol = _symbol(arguments)
    if symbol is None:
        return {"error": "symbol is a ticker, e.g. NVDA"}
    days = arguments.get("days", DEFAULT_HISTORY_DAYS)
    if not isinstance(days, int) or not 5 <= days <= MAX_HISTORY_DAYS:
        return {"error": f"days is a whole number from 5 to {MAX_HISTORY_DAYS}"}
    listing = find_listing(context.engine, symbol)
    if listing is None:
        return _unknown(symbol)
    points = await _stored_closes(context, listing, days)
    if len(points) < 2:
        return {"symbol": symbol, "closes": [], "note": "no daily closes are available"}
    currency = points[-1].currency
    step = max(1, -(-len(points) // MAX_HISTORY_POINTS))
    sampled = points[::-1][::step][::-1]
    prices = [point.price_minor for point in points]

    def back(n: int) -> str | None:
        return _change_pct(prices[-1 - n], prices[-1]) if len(prices) > n else None

    return {
        "symbol": symbol,
        "currency": currency,
        "last_close": money(prices[-1], currency),
        "last_close_date": points[-1].as_of.date().isoformat(),
        "change_pct": {
            "5d": back(5),
            "20d": back(20),
            "60d": back(60),
            "period": back(len(prices) - 1),
        },
        "high": money(max(prices), currency),
        "low": money(min(prices), currency),
        "closes": [
            {"date": point.as_of.date().isoformat(), "close": money(point.price_minor, currency)}
            for point in sampled
        ],
        **({"sampling": f"every {step} trading days"} if step > 1 else {}),
    }


# -- get_findings --------------------------------------------------------------


async def get_findings(context: ToolContext, arguments: Mapping[str, Any]) -> dict[str, Any]:
    symbol = _symbol(arguments)
    if symbol is None:
        return {"error": "symbol is a ticker, e.g. NVDA"}
    listing = find_listing(context.engine, symbol)
    if listing is None:
        return _unknown(symbol)
    await _stored_closes(context, listing, FINDINGS_DAYS)
    with context.engine.connect() as connection:
        points = load_price_series(
            connection,
            listing.instrument_id,
            since=context.now - timedelta(days=FINDINGS_DAYS),
            excluded_sources=context.excluded_price_sources,
        )
    if len(points) < 2:
        return {"symbol": symbol, "findings": [], "note": "not enough price history to analyse"}
    findings = [
        *price_move_findings(symbol, points, context.thresholds),
        *sigma_move_findings(symbol, points, context.thresholds),
        *drawdown_findings(symbol, points, context.thresholds),
    ]
    return {
        "symbol": symbol,
        "findings": [
            {
                "kind": finding.kind,
                "severity": finding.severity,
                "as_of": finding.as_of.isoformat(),
                "evidence": finding.evidence,
            }
            for finding in findings
        ],
        **({} if findings else {"note": "no rule found anything notable"}),
    }


# -- get_news ------------------------------------------------------------------


async def get_news(context: ToolContext, arguments: Mapping[str, Any]) -> dict[str, Any]:
    symbol = _symbol(arguments)
    if symbol is None:
        return {"error": "symbol is a ticker, e.g. NVDA"}
    days = arguments.get("days", DEFAULT_NEWS_DAYS)
    if not isinstance(days, int) or not 1 <= days <= MAX_NEWS_DAYS:
        return {"error": f"days is a whole number from 1 to {MAX_NEWS_DAYS}"}
    listing = find_listing(context.engine, symbol)
    if listing is None:
        return _unknown(symbol)
    with context.engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                SELECT DISTINCT ON (a.id) a.title, a.source, a.published_at, s.score
                  FROM article_entities e
                  JOIN articles a ON a.id = e.article_id AND a.duplicate_of_id IS NULL
                  LEFT JOIN article_sentiment s ON s.article_id = a.id
                 WHERE e.instrument_id = CAST(:instrument AS uuid)
                   AND a.published_at >= :since
                 ORDER BY a.id, s.created_at DESC
                """
            ),
            {"instrument": listing.instrument_id, "since": context.now - timedelta(days=days)},
        ).all()
    articles = sorted(rows, key=lambda row: row.published_at, reverse=True)[:MAX_NEWS_ARTICLES]
    return {
        "symbol": symbol,
        "days": days,
        "articles": [
            {
                "title": row.title,
                "source": row.source,
                "published": row.published_at.isoformat(),
                "sentiment": None if row.score is None else str(row.score),
            }
            for row in articles
        ],
        **(
            {}
            if articles
            else {"note": "no stored news; news is collected only for followed instruments"}
        ),
    }


# -- get_position --------------------------------------------------------------


async def get_position(context: ToolContext, arguments: Mapping[str, Any]) -> dict[str, Any]:
    symbol = _symbol(arguments)
    with context.engine.connect() as connection:
        cash = connection.execute(
            text(
                "SELECT balance_minor, currency FROM agent_cash "
                "WHERE agent_id = CAST(:agent AS uuid) AND user_id = CAST(:user AS uuid)"
            ),
            {"agent": context.agent_id, "user": context.user_id},
        ).one_or_none()
        rows = connection.execute(
            text(
                """
                SELECT i.symbol, i.currency, h.quantity, h.cost_basis_minor, h.opened_at
                  FROM holdings h
                  JOIN instruments i ON i.id = h.instrument_id
                 WHERE h.agent_id = CAST(:agent AS uuid) AND h.user_id = CAST(:user AS uuid)
                   AND (CAST(:symbol AS text) IS NULL OR i.symbol = :symbol)
                 ORDER BY i.symbol
                """
            ),
            {"agent": context.agent_id, "user": context.user_id, "symbol": symbol},
        ).all()
    return {
        "cash": money(cash.balance_minor, cash.currency) if cash else None,
        "holdings": [
            {
                "symbol": row.symbol,
                "quantity": str(Decimal(row.quantity).normalize()),
                "cost_per_share": (
                    money(row.cost_basis_minor, row.currency)
                    if row.cost_basis_minor is not None
                    else None
                ),
                "opened": row.opened_at.isoformat() if row.opened_at else None,
            }
            for row in rows
        ],
        **({"note": f"no position in {symbol}"} if symbol and not rows else {}),
    }


# -- explain_concept -----------------------------------------------------------


async def explain_concept(context: ToolContext, arguments: Mapping[str, Any]) -> dict[str, Any]:
    query = arguments.get("query")
    if not isinstance(query, str) or not query.strip():
        return {"error": "query is a term, e.g. 'drawdown' or 'expense ratio'"}
    with context.engine.connect() as connection:
        result = await hybrid_search(
            connection,
            context.vector_store,
            context.embedder,
            query=query.strip(),
            limit=MAX_CONCEPT_CHUNKS,
        )
    return {
        "query": query.strip(),
        "excerpts": [
            {
                "concept": chunk.concept_slug,
                "title": chunk.title,
                "text": chunk.text[:MAX_CONCEPT_CHARS],
            }
            for chunk in result.chunks
        ],
    }


# -- the set -------------------------------------------------------------------


def _object(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


_SYMBOL = {"type": "string", "description": "A ticker, e.g. NVDA."}

TOOLS: tuple[Tool, ...] = (
    Tool(
        ToolSpec(
            "search_universe",
            "Find instruments in the tradable universe by what they do, e.g. 'gene editing'.",
            _object({"query": {"type": "string"}}, ["query"]),
        ),
        search_universe,
    ),
    Tool(
        ToolSpec(
            "get_quote",
            f"Delayed quotes for up to {MAX_QUOTE_SYMBOLS} symbols, and whether each is tradable.",
            _object(
                {"symbols": {"type": "array", "items": _SYMBOL, "maxItems": MAX_QUOTE_SYMBOLS}},
                ["symbols"],
            ),
        ),
        get_quote,
    ),
    Tool(
        ToolSpec(
            "get_price_history",
            "Daily closes over a period, with returns over 5, 20 and 60 days and the high and low.",
            _object(
                {
                    "symbol": _SYMBOL,
                    "days": {"type": "integer", "minimum": 5, "maximum": MAX_HISTORY_DAYS},
                },
                ["symbol"],
            ),
        ),
        get_price_history,
    ),
    Tool(
        ToolSpec(
            "get_findings",
            "What the rules find in a symbol's recent prices: big or unusual moves, drawdowns.",
            _object({"symbol": _SYMBOL}, ["symbol"]),
        ),
        get_findings,
    ),
    Tool(
        ToolSpec(
            "get_news",
            "Recent stored news articles about a symbol, with a sentiment score from -1 to 1.",
            _object(
                {
                    "symbol": _SYMBOL,
                    "days": {"type": "integer", "minimum": 1, "maximum": MAX_NEWS_DAYS},
                },
                ["symbol"],
            ),
        ),
        get_news,
    ),
    Tool(
        ToolSpec(
            "get_position",
            "Your cash and your holdings (all of them, or one symbol's), with cost per share.",
            _object({"symbol": _SYMBOL}, []),
        ),
        get_position,
    ),
    Tool(
        ToolSpec(
            "explain_concept",
            "A short excerpt from the product's finance glossary, e.g. 'sharpe ratio'.",
            _object({"query": {"type": "string"}}, ["query"]),
        ),
        explain_concept,
    ),
)

TOOLS_BY_NAME: dict[str, Tool] = {tool.spec.name: tool for tool in TOOLS}


async def run_tool(context: ToolContext, name: str, arguments_text: str) -> str:
    """Run one tool call as the model wrote it and answer the JSON the model will read.

    The model's mistakes - an unknown tool, arguments that are not a JSON
    object - come back as an error it can read and correct; ours raise.
    """
    tool = TOOLS_BY_NAME.get(name)
    if tool is None:
        return json.dumps({"error": f"no tool named {name}; the tools are {sorted(TOOLS_BY_NAME)}"})
    try:
        arguments = json.loads(arguments_text or "{}")
    except json.JSONDecodeError:
        return json.dumps({"error": "arguments were not valid JSON"})
    if not isinstance(arguments, dict):
        return json.dumps({"error": "arguments must be a JSON object"})
    return json.dumps(await tool.handler(context, arguments), ensure_ascii=False, default=str)


def scan_context(
    *,
    engine: Engine,
    market: MarketDataService,
    embedder: BaseEmbedder,
    vector_store: VectorStore,
    thresholds: AnalysisThresholds,
    excluded_price_sources: tuple[str, ...],
    user_id: str,
    agent_id: str,
    now: datetime | None = None,
) -> ToolContext:
    return ToolContext(
        engine=engine,
        market=market,
        embedder=embedder,
        vector_store=vector_store,
        thresholds=thresholds,
        excluded_price_sources=excluded_price_sources,
        user_id=user_id,
        agent_id=agent_id,
        now=now or datetime.now(UTC),
    )
