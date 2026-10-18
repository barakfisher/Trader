"""The world the assistant eval is asked in: a disposable database, and one account per case.

`data/eval/assistant.json` describes three account states in words (`fixtures`):
`demo`, `empty` and `unpriced`. This module is those words as rows.

**Built, not copied.** A copy of the live database would answer with real news
and real prices, so a case would grade differently every week and two models
compared a day apart would not have seen the same world. Everything here comes
from committed files (`data/fixtures`, `data/universe`, `data/corpus`) or is
written below, and every time is relative to the run's clock - so the world on
any day is the same world, shifted.

**Figures the cases quote are the rules' own.** The drawdown alert is
`drawdown_findings` run over the fixture prices, not a number typed here; a
scan's tool results are what the tool returns for the fixture. What *is* typed
here - a thesis, a scan's error, a topic's weekly move - is stored where the
tools read it, so the assistant meets it as evidence, as it would a real one.

**One account per case**, so no case reads another's conversation or spend.
The universe, the corpus and the news are shared: nothing a case does writes them.

The database is wiped first, so its name must end in `_ci` or `_test`, the
rule the integration tests keep (`tests/integration/conftest.py`).
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.engine.url import make_url

from app.analysis.drawdown import drawdown_findings
from app.analysis.price_series import PricePoint
from app.analysis.thresholds import AnalysisThresholds
from app.assistant.tools import primary_agent_id
from app.corpus.hashed_embedder import HashedEmbedder
from app.universe.loading import load_into_database
from app.universe.profiles import embed_pending
from scripts.assistant_eval.market import UNPRICED_SYMBOL, EvalMarket

SERVICE_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = SERVICE_DIR.parents[1]
DISPOSABLE_SUFFIXES = ("_ci", "_test")

#: Instruments the cases name beyond the fixture universe's eleven, described in
#: our own words (as `data/fixtures/universe/descriptions.jsonl` is). Their
#: membership rows - names, sizes, exchanges - are the committed universe's.
EVAL_DESCRIPTIONS: dict[str, str] = {
    "NVDA": "Designs graphics processors and accelerators used in data centres, gaming and AI.",
    "AMD": "Designs CPUs, graphics processors and data-centre accelerators.",
    "SMR": "Develops small modular nuclear reactors for power generation.",
    "TSLA": "Makes electric vehicles, batteries and energy storage systems.",
    "AAPL": "Makes phones, computers and wearables and sells software services.",
    "MSFT": "Sells software, cloud computing and productivity services.",
    "QQQ": "An exchange-traded fund tracking the hundred largest non-financial Nasdaq stocks.",
    "VOO": "An exchange-traded fund tracking the S&P 500 index of large US companies.",
    "XOM": "Explores for, produces and refines oil and natural gas.",
    "USO": "An exchange-traded fund that tracks the price of crude oil futures.",
    "RIVN": "Makes electric pickup trucks, SUVs and delivery vans.",
}
#: Left the universe at the seeded rescreen (`universe-dropped`).
DROPPED_AT_RESCREEN = ("AEM", "SYK")
RESCREEN_DAYS_AGO = 20

TOPIC = "Uranium & Nuclear Energy"
TOPIC_MEMBERS = {
    "CCJ": "Mines and sells uranium for nuclear power plants.",
    "URA": "Holds uranium miners and nuclear fuel companies.",
    "SMR": "Builds small modular nuclear reactors.",
    "LEU": "Supplies enriched uranium fuel for reactors.",
}

#: The real portfolio: symbol -> (quantity, cost per unit, opened days ago).
DEMO_HOLDINGS: dict[str, tuple[str, str, int]] = {
    "NVDA": ("40", "98.75", 420),
    "AMD": ("25", "120.00", 300),
    "SMR": ("200", "7.15", 380),
    "URA": ("150", "24.10", 400),
    "CCJ": ("60", "42.00", 250),
}
UNPRICED_HOLDING = (UNPRICED_SYMBOL, "100", "9.00", 90)
#: The total's level on earlier days against today's: a small move today (the
#: `demo` fixture's "well under 5%"), down on the week, up on the month.
SNAPSHOT_LEVELS = {0: Decimal("1"), 1: Decimal("0.988"), 7: Decimal("1.031"), 30: Decimal("0.957")}

MODEL = "google/gemini-3.5-flash-lite"

#: Stored news: (symbol, days ago, source, title, body). Our own words; the
#: fixture's articles are added beside them (`_fixture_articles`).
EVAL_ARTICLES: tuple[tuple[str, int, str, str, str], ...] = (
    (
        "TSLA",
        0,
        "Example Newswire",
        "Tesla trims its delivery outlook as price cuts weigh on margins",
        "Tesla ($TSLA) lowered its delivery outlook for the quarter and said recent price "
        "cuts had narrowed its automotive margin.",
    ),
    (
        "TSLA",
        2,
        "Example Markets Daily",
        "Tesla opens orders for a lower-priced model in two markets",
        "Tesla ($TSLA) began taking orders for a cheaper model in two markets, its first "
        "new trim this year.",
    ),
    (
        "XOM",
        0,
        "Example Newswire",
        "Oil rises after a supply cut extends into next quarter",
        "Crude prices rose after producers extended a supply cut into next quarter; Exxon "
        "Mobil ($XOM) and other majors traded higher.",
    ),
    (
        "USO",
        0,
        "Example Markets Daily",
        "Crude oil fund gains as inventories fall for a third week",
        "The United States Oil Fund ($USO) gained as weekly inventory data showed a third "
        "straight draw.",
    ),
    (
        "SMR",
        3,
        "Example Energy Wire",
        "NuScale shares slide as a utility delays a reactor decision",
        "NuScale Power ($SMR) fell after a utility said it would delay its decision on a "
        "reactor order to next year.",
    ),
)
#: The committed fixture's articles that name an instrument the eval loads, by title prefix.
FIXTURE_ARTICLE_SYMBOLS = {
    "Apple posts record": "AAPL",
    "Apple faces a second": "AAPL",
    "Microsoft raises": "MSFT",
    "Microsoft names": "MSFT",
    "Nvidia slumps": "NVDA",
    "AI capex race": "NVDA",
    "Regulator sets": "SMR",
    "NuScale Power wins": "SMR",
    "Uranium fund draws": "URA",
    "Vanguard trims": "VOO",
    "Tech selloff drags": "QQQ",
    "Ten-year yields ease": "VOO",
}


# -- the database ---------------------------------------------------------------


def disposable(database_url: str) -> str:
    """The URL, if its database may be wiped; raises otherwise."""
    name = make_url(database_url).database or ""
    if not name.endswith(DISPOSABLE_SUFFIXES):
        raise SystemExit(
            f"the eval wipes its database; {name!r} does not end in {DISPOSABLE_SUFFIXES}"
        )
    return database_url


def _script(database_url: str, *args: str) -> None:
    """Run a service command as its container does (see `tests/integration/conftest.py`)."""
    result = subprocess.run(
        [sys.executable, *args],
        cwd=SERVICE_DIR,
        env={
            **os.environ,
            "DATABASE_URL": database_url,
            "PYTHONPATH": str(SERVICE_DIR),
            "EMBEDDINGS_PROVIDER": "fixture",
        },
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"{' '.join(args)} failed:\n{result.stdout}\n{result.stderr}")


async def build_database(engine: Engine, database_url: str, now: datetime) -> None:
    """An empty database at head with the corpus, the universe and the news loaded."""
    disposable(database_url)
    with engine.begin() as connection:
        schemas = connection.execute(
            text(
                "SELECT schema_name FROM information_schema.schemata "
                "WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema'"
            )
        ).scalars()
        for schema in list(schemas):
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        connection.execute(text("CREATE SCHEMA public"))
    _script(database_url, "-m", "alembic", "upgrade", "head")
    _script(database_url, "scripts/ingest_corpus.py")
    with engine.begin() as connection:
        await _load_universe(connection, now)
    with engine.begin() as connection:
        _load_news(connection, now)


async def _load_universe(connection: Connection, now: datetime) -> None:
    fixture = REPO_ROOT / "data" / "fixtures" / "universe" / "descriptions.jsonl"
    with tempfile.TemporaryDirectory() as scratch:
        descriptions = Path(scratch) / "descriptions.jsonl"
        lines = fixture.read_text(encoding="utf-8").splitlines()
        lines += [
            json.dumps({"symbol": symbol, "description": description})
            for symbol, description in EVAL_DESCRIPTIONS.items()
        ]
        descriptions.write_text("\n".join(line for line in lines if line) + "\n", "utf-8")
        load_into_database(
            connection,
            REPO_ROOT / "data" / "universe",
            descriptions=descriptions,
            source="fixture:assistant-eval",
            license="written for this repository",
        )
    await embed_pending(connection, HashedEmbedder())
    rescreened = now - timedelta(days=RESCREEN_DAYS_AGO)
    connection.execute(
        text(
            "UPDATE instrument_profiles p SET membership = 'dropped' FROM instruments i "
            "WHERE i.id = p.instrument_id AND i.symbol = ANY(:symbols)"
        ),
        {"symbols": list(DROPPED_AT_RESCREEN)},
    )
    connection.execute(
        text(
            "INSERT INTO runs (kind, run_key, trigger, status, started_at, finished_at, stats) "
            "VALUES ('universe_rescreen', :key, 'schedule', 'ok', :at, :at, CAST(:stats AS jsonb))"
        ),
        {
            "key": f"universe_rescreen:{rescreened.date().isoformat()}",
            "at": rescreened,
            "stats": json.dumps({"created": 3, "dropped": len(DROPPED_AT_RESCREEN)}),
        },
    )


def _instrument(connection: Connection, symbol: str) -> str:
    return connection.execute(
        text("SELECT id::text FROM instruments WHERE symbol = :s"), {"s": symbol}
    ).scalar_one()


def _article(
    connection: Connection, symbol: str, at: datetime, source: str, title: str, body: str, url: str
) -> None:
    article = connection.execute(
        text(
            "INSERT INTO articles (url_hash, url, source, published_at, title, raw_text, "
            "content_hash, feed) VALUES (:uh, :url, :source, :at, :title, :body, :ch, 'followed') "
            "RETURNING id::text"
        ),
        {
            "uh": hashlib.sha256(url.encode()).hexdigest(),
            "url": url,
            "source": source,
            "at": at,
            "title": title,
            "body": body,
            "ch": hashlib.sha256(body.encode()).hexdigest(),
        },
    ).scalar_one()
    connection.execute(
        text(
            "INSERT INTO article_entities (article_id, entity_kind, instrument_id, salience, "
            "match_method, matched_text) VALUES (CAST(:a AS uuid), 'instrument', "
            "CAST(:i AS uuid), 0.9, 'cashtag', :t)"
        ),
        {"a": article, "i": _instrument(connection, symbol), "t": f"${symbol}"},
    )


def _load_news(connection: Connection, now: datetime) -> None:
    fixture = json.loads((REPO_ROOT / "data" / "fixtures" / "news.json").read_text("utf-8"))
    # The fixture's articles keep their order of days, moved so the newest is
    # this morning: "what's in the news today?" has holdings news to find.
    dates = [
        datetime.fromisoformat(a["published_at"].replace("Z", "+00:00"))
        for a in fixture["articles"]
    ]
    shift = (now - timedelta(hours=4)) - max(dates)
    for article, published in zip(fixture["articles"], dates, strict=True):
        symbol = next(
            (
                s
                for prefix, s in FIXTURE_ARTICLE_SYMBOLS.items()
                if article["title"].startswith(prefix)
            ),
            None,
        )
        if symbol is not None:
            _article(
                connection,
                symbol,
                published + shift,
                article["source"],
                article["title"],
                article["body"],
                article["url"],
            )
    for n, (symbol, days_ago, source, title, body) in enumerate(EVAL_ARTICLES):
        _article(
            connection,
            symbol,
            now - timedelta(days=days_ago, hours=2),
            source,
            title,
            body,
            f"https://news.example.com/assistant-eval/{n}",
        )


# -- an account -------------------------------------------------------------------


@dataclass
class Account:
    """What a case's runner needs to know about the account it seeded."""

    fixture: str
    user_id: str
    primary_id: str
    agents: dict[str, str] = field(default_factory=dict)
    proposals: dict[str, str] = field(default_factory=dict)
    scans: dict[str, str] = field(default_factory=dict)


def _money(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.01')):f}"


async def seed_account(engine: Engine, market: EvalMarket, fixture: str, now: datetime) -> Account:
    """A new user in the state `fixture` names (`assistant.json`'s `fixtures`)."""
    if fixture not in ("demo", "empty", "unpriced"):
        raise ValueError(f"unknown fixture {fixture!r}")
    holdings = (
        {}
        if fixture == "empty"
        else {
            **DEMO_HOLDINGS,
            **({UNPRICED_HOLDING[0]: UNPRICED_HOLDING[1:]} if fixture == "unpriced" else {}),
        }
    )
    quotes = {q.symbol: q for q in (await market.quotes(list(holdings)))[0]} if holdings else {}
    smr_points = [
        PricePoint(c.as_of, c.price_minor, c.currency) for c in await market.history("SMR", 90)
    ]
    with engine.begin() as connection:
        user = connection.execute(
            text(
                "INSERT INTO users (role, status, llm_cap_micro_usd) "
                "VALUES ('user', 'active', 10000000) RETURNING id::text"
            )
        ).scalar_one()
        primary = primary_agent_id(connection, user)
        assert primary is not None
        account = Account(fixture=fixture, user_id=user, primary_id=primary)
        # No cash row: the real portfolio is passive and keeps none (the
        # ledger's trigger refuses one); only an agent holds paper cash.
        _holdings(connection, user, primary, holdings, now)
        if holdings:
            _snapshots(connection, user, primary, holdings, quotes, now)
        if fixture != "empty":
            _agents(connection, account, now)
            _observations(connection, account, smr_points, now)
            _topic(connection, account, now)
    return account


def _holdings(
    connection: Connection,
    user: str,
    agent: str,
    holdings: dict[str, tuple[str, str, int]],
    now: datetime,
) -> None:
    for symbol, (quantity, cost, days_ago) in holdings.items():
        connection.execute(
            text(
                "INSERT INTO holdings (user_id, agent_id, instrument_id, quantity, "
                "cost_basis_minor, opened_at) VALUES (CAST(:u AS uuid), CAST(:a AS uuid), "
                "CAST(:i AS uuid), CAST(:q AS numeric), :c, :o)"
            ),
            {
                "u": user,
                "a": agent,
                "i": _instrument(connection, symbol),
                "q": quantity,
                "c": int(Decimal(cost) * 100),
                "o": (now - timedelta(days=days_ago)).date(),
            },
        )


def _snapshots(
    connection: Connection,
    user: str,
    agent: str,
    holdings: dict[str, tuple[str, str, int]],
    quotes: dict[str, Any],
    now: datetime,
) -> None:
    """Daily totals at today's prices, scaled by `SNAPSHOT_LEVELS` for earlier days."""
    values = {
        symbol: int(Decimal(quantity) * quotes[symbol].price_minor)
        for symbol, (quantity, _cost, _days) in holdings.items()
        if symbol in quotes
    }
    total = sum(values.values())
    cost = sum(int(Decimal(q) * Decimal(c) * 100) for q, c, _d in holdings.values())
    breakdown = [
        {
            "symbol": symbol,
            "valueMinor": value,
            "weightPct": float((Decimal(value) * 100 / total).quantize(Decimal("0.01"))),
        }
        for symbol, value in values.items()
    ]
    for days_ago, level in SNAPSHOT_LEVELS.items():
        connection.execute(
            text(
                "INSERT INTO portfolio_snapshots (user_id, agent_id, as_of, total_minor, "
                "cost_minor, currency, breakdown, holdings_count, priced_count, degraded) "
                "VALUES (CAST(:u AS uuid), CAST(:a AS uuid), :d, :t, :c, 'USD', "
                "CAST(:b AS jsonb), :n, :p, :g)"
            ),
            {
                "u": user,
                "a": agent,
                "d": (now - timedelta(days=days_ago)).date(),
                "t": int(total * level),
                "c": cost,
                "b": json.dumps(breakdown),
                "n": len(holdings),
                "p": len(values),
                "g": len(values) < len(holdings),
            },
        )


def _agent(
    connection: Connection,
    account: Account,
    *,
    slug: str,
    name: str,
    persona: str,
    schedule: str,
    cash_minor: int,
    holdings: dict[str, tuple[str, str, int]],
    now: datetime,
) -> str:
    """An agent whose ledger agrees with its holdings: each holding is a fill on the
    day it was opened, and the budget is what leaves `cash_minor` after them - so
    month_to_date can replay the ledger as it does on a real installation."""
    spent = {
        symbol: int(Decimal(quantity) * Decimal(cost) * 100)
        for symbol, (quantity, cost, _days) in holdings.items()
    }
    agent = connection.execute(
        text(
            "INSERT INTO agents (user_id, slug, name, persona, budget_minor, scan_schedule, "
            "created_at) VALUES (CAST(:u AS uuid), :slug, :name, :persona, :budget, :schedule, "
            ":created) RETURNING id::text"
        ),
        {
            "u": account.user_id,
            "slug": slug,
            "name": name,
            "persona": persona,
            "budget": cash_minor + sum(spent.values()),
            "schedule": schedule,
            "created": now - timedelta(days=40),
        },
    ).scalar_one()
    for symbol, (quantity, cost, days_ago) in holdings.items():
        # A user's fill, not the agent's: an agent's fill needs a proposal behind it
        # (fills_agent_has_proposal), and nothing the assistant reads tells them apart.
        connection.execute(
            text(
                "INSERT INTO fills (user_id, agent_id, instrument_id, side, quantity, "
                "price_minor, notional_minor, fee_minor, price_source, source, "
                "idempotency_key, created_at) VALUES (CAST(:u AS uuid), CAST(:a AS uuid), "
                "CAST(:i AS uuid), 'buy', CAST(:q AS numeric), :p, :n, 0, 'user', "
                "'manual_user_override', :k, :at)"
            ),
            {
                "u": account.user_id,
                "a": agent,
                "i": _instrument(connection, symbol),
                "q": quantity,
                "p": int(Decimal(cost) * 100),
                "n": spent[symbol],
                "k": f"eval-{slug}-{symbol}",
                "at": now - timedelta(days=days_ago),
            },
        )
    _holdings(connection, account.user_id, agent, holdings, now)
    account.agents[name] = agent
    return agent


def _scan(
    connection: Connection,
    account: Account,
    agent: str,
    *,
    started: datetime,
    outcome: str,
    holdings: list[str],
    cash: str,
    steps: list[tuple[str, dict[str, Any], dict[str, Any]]],
    answer: dict[str, Any] | None,
    error: str | None,
    cost_micro_usd: int,
) -> str:
    """A finished scan, its transcript and the model calls that paid for it."""
    transcript: list[dict[str, Any]] = []
    for n, (tool, arguments, result) in enumerate(steps, start=1):
        call = f"call-{n}"
        transcript.append(
            {
                "role": "assistant",
                "text": "",
                "tool_calls": [{"id": call, "name": tool, "arguments": json.dumps(arguments)}],
            }
        )
        transcript.append({"role": "tool", "call_id": call, "name": tool, "result": result})
    transcript.append({"role": "assistant", "text": json.dumps(answer or {}), "tool_calls": []})
    briefing = {
        "cash": cash,
        "holdings": [{"symbol": s} for s in holdings],
        "movers": {
            "gainers": [{"symbol": "SMR"}, {"symbol": "URA"}],
            "losers": [{"symbol": "NVDA"}],
        },
        "followed_topics": [TOPIC],
    }
    scan = connection.execute(
        text(
            "INSERT INTO agent_scans (user_id, agent_id, trigger, started_at, finished_at, "
            "outcome, steps, cost_micro_usd, model, briefing, transcript, answer, error) "
            "VALUES (CAST(:u AS uuid), CAST(:a AS uuid), 'schedule', :s, :f, :o, :n, :c, :m, "
            "CAST(:b AS jsonb), CAST(:t AS jsonb), CAST(:ans AS jsonb), :e) RETURNING id::text"
        ),
        {
            "u": account.user_id,
            "a": agent,
            "s": started,
            "f": started + timedelta(seconds=40),
            "o": outcome,
            "n": len(steps) + 1,
            "c": cost_micro_usd,
            "m": MODEL,
            "b": json.dumps(briefing),
            "t": json.dumps(transcript),
            "ans": None if answer is None else json.dumps(answer),
            "e": error,
        },
    ).scalar_one()
    turns = len(steps) + 1
    for n in range(turns):
        connection.execute(
            text(
                "INSERT INTO llm_calls (user_id, agent_id, provider, model, outcome, latency_ms, "
                "prompt_tokens, completion_tokens, cost_micro_usd, prompt, started_at, purpose) "
                "VALUES (CAST(:u AS uuid), CAST(:a AS uuid), 'openrouter', :m, 'ok', 900, 3000, "
                "150, :c, '(seeded by the assistant eval)', :at, 'agent_scan')"
            ),
            {
                "u": account.user_id,
                "a": agent,
                "m": MODEL,
                "c": cost_micro_usd // turns + (cost_micro_usd % turns if n == 0 else 0),
                "at": started + timedelta(seconds=5 * n),
            },
        )
    return scan


def _trade_proposal(
    connection: Connection,
    account: Account,
    agent: str,
    scan: str,
    answer: dict[str, Any],
    *,
    kind: str,
    created: datetime,
    state: str,
    decided: datetime | None = None,
) -> str:
    """As the orchestrator writes one (`queries/tradeProposals.ts`)."""
    symbol = answer["symbol"]
    observation = connection.execute(
        text(
            "INSERT INTO observations (user_id, agent_id, kind, severity, subject_kind, "
            "subject_ref, headline, explanation, evidence, dedupe_key, narration_source, "
            "created_at) VALUES (CAST(:u AS uuid), CAST(:a AS uuid), 'agent_trade', 'notable', "
            "'instrument', :ref, :headline, :thesis, CAST(:evidence AS jsonb), :key, 'llm', :at) "
            "RETURNING id::text"
        ),
        {
            "u": account.user_id,
            "a": agent,
            "ref": f"instrument:{symbol}",
            "headline": f"Proposes to {kind} {answer['quantity']} {symbol}",
            "thesis": answer["thesis"],
            "evidence": json.dumps({"scanId": scan}),
            "key": f"agent_scan:{scan}",
            "at": created,
        },
    ).scalar_one()
    return connection.execute(
        text(
            "INSERT INTO proposals (user_id, agent_id, observation_id, kind, payload, state, "
            "expires_at, decided_at, decided_via, created_at, scan_id) VALUES (CAST(:u AS uuid), "
            "CAST(:a AS uuid), CAST(:o AS uuid), :kind, CAST(:p AS jsonb), :state, :expires, "
            ":decided, :via, :at, CAST(:scan AS uuid)) RETURNING id::text"
        ),
        {
            "u": account.user_id,
            "a": agent,
            "o": observation,
            "kind": kind,
            "p": json.dumps(
                {
                    "symbol": symbol,
                    "quantity": answer["quantity"],
                    "priceMinor": answer["price_minor"],
                    "currency": "USD",
                    "priceAsOf": answer["price_as_of"],
                }
            ),
            "state": state,
            "expires": created + timedelta(hours=24),
            "decided": decided,
            "via": "web" if decided else None,
            "at": created,
            "scan": scan,
        },
    ).scalar_one()


def _agents(connection: Connection, account: Account, now: datetime) -> None:
    """Momentum (a pending SMR buy) and Value (a rejected URA sell, then a failed scan)."""
    momentum = _agent(
        connection,
        account,
        slug="momentum",
        name="Momentum",
        persona="Buys what has been rising with volume behind it and sells when the trend breaks.",
        schedule="pre_open",
        cash_minor=600_000,
        holdings={"NVDA": ("10", "110.00", 30), "AMD": ("8", "150.00", 20)},
        now=now,
    )
    value = _agent(
        connection,
        account,
        slug="value",
        name="Value",
        persona="Looks for holdings that have run ahead of themselves and trims them.",
        schedule="pre_open_post_close",
        cash_minor=750_000,
        holdings={"URA": ("40", "26.00", 35)},
        now=now,
    )

    as_of = (now - timedelta(hours=3)).replace(second=0, microsecond=0).isoformat()
    buy = {
        "decision": "buy",
        "symbol": "SMR",
        "quantity": "50",
        "thesis": (
            "SMR rose 10.65% today to $9.87 after news of a first commercial reactor order, and "
            "it belongs to the followed topic Uranium & Nuclear Energy. Buying 50 shares uses "
            "$493.50 of the $6000.00 cash."
        ),
        "price_minor": 987,
        "price_as_of": as_of,
    }
    yesterday = now - timedelta(days=1, hours=3)
    account.scans["momentum-earlier"] = _scan(
        connection,
        account,
        momentum,
        started=yesterday,
        outcome="no_trade",
        holdings=["NVDA", "AMD"],
        cash="6000.00",
        steps=[
            (
                "get_quote",
                {"symbols": ["NVDA", "AMD"]},
                {"quotes": {"NVDA": {"price": "118.45"}, "AMD": {"price": "162.40"}}},
            )
        ],
        answer={
            "decision": "none",
            "symbol": None,
            "quantity": None,
            "thesis": "Nothing in the briefing moved enough to act on.",
            "price_minor": None,
            "price_as_of": None,
        },
        error=None,
        cost_micro_usd=2_100,
    )
    scan = _scan(
        connection,
        account,
        momentum,
        started=now - timedelta(hours=3),
        outcome="trade",
        holdings=["NVDA", "AMD"],
        cash="6000.00",
        steps=[
            (
                "search_universe",
                {"query": "nuclear reactors"},
                {
                    "query": "nuclear reactors",
                    "matches": [
                        {"symbol": "SMR", "name": "NuScale Power Corporation", "kind": "equity"}
                    ],
                },
            ),
            (
                "get_quote",
                {"symbols": ["SMR"]},
                {
                    "quotes": {
                        "SMR": {
                            "price": "9.87",
                            "previous_close": "8.92",
                            "day_change_percent": 10.6502,
                            "as_of": as_of,
                        }
                    }
                },
            ),
            (
                "get_news",
                {"symbol": "SMR"},
                {
                    "symbol": "SMR",
                    "articles": [
                        {
                            "title": (
                                "NuScale Power wins a first commercial order for its reactor module"
                            ),
                            "source": "Example Newswire",
                        }
                    ],
                },
            ),
        ],
        answer=buy,
        error=None,
        cost_micro_usd=4_200,
    )
    account.scans["momentum"] = scan
    account.proposals["smr-buy"] = _trade_proposal(
        connection,
        account,
        momentum,
        scan,
        buy,
        kind="buy",
        created=now - timedelta(hours=3),
        state="pending",
    )

    sell = {
        "decision": "sell",
        "symbol": "URA",
        "quantity": "40",
        "thesis": (
            "URA is 6.31% above its price five days ago after record fund inflows; the position "
            "has run ahead of the rest of the portfolio, so selling all 40 shares takes the gain."
        ),
        "price_minor": 2764,
        "price_as_of": (now - timedelta(days=3)).replace(second=0, microsecond=0).isoformat(),
    }
    earlier = _scan(
        connection,
        account,
        value,
        started=now - timedelta(days=3),
        outcome="trade",
        holdings=["URA"],
        cash="7500.00",
        steps=[
            (
                "get_position",
                {"symbol": "URA"},
                {"holdings": [{"symbol": "URA", "quantity": "40", "cost_per_share": "26.00"}]},
            ),
            (
                "get_price_history",
                {"symbol": "URA", "days": 30},
                {"symbol": "URA", "change_percent": {"5d": "6.31"}},
            ),
        ],
        answer=sell,
        error=None,
        cost_micro_usd=3_300,
    )
    account.scans["value-earlier"] = earlier
    account.proposals["ura-sell"] = _trade_proposal(
        connection,
        account,
        value,
        earlier,
        sell,
        kind="sell",
        created=now - timedelta(days=3),
        state="rejected",
        decided=now - timedelta(days=2, hours=20),
    )
    account.scans["value"] = _scan(
        connection,
        account,
        value,
        started=now - timedelta(hours=2),
        outcome="invalid_answer",
        holdings=["URA"],
        cash="7500.00",
        steps=[
            (
                "get_quote",
                {"symbols": ["URA"]},
                {"quotes": {"URA": {"price": "27.64", "day_change_percent": 5.6979}}},
            )
        ],
        answer={
            "decision": "sell",
            "symbol": "URA",
            "quantity": "20",
            "thesis": "URA is up 12.5% this month, so trimming half the position locks in gains.",
            "price_minor": None,
            "price_as_of": None,
        },
        error="the thesis quotes 12.5%, which no tool result or briefing figure contains",
        cost_micro_usd=2_900,
    )


def _observations(
    connection: Connection, account: Account, smr_points: list[PricePoint], now: datetime
) -> None:
    """The drawdown alert yesterday: the drawdown rule over SMR's fixture prices."""
    finding = max(
        drawdown_findings("SMR", smr_points, AnalysisThresholds()),
        key=lambda f: abs(f.evidence["drawdown_pct"]),
    )
    decline = Decimal(str(abs(finding.evidence["drawdown_pct"]) * 100)).quantize(Decimal("0.01"))
    connection.execute(
        text(
            "INSERT INTO observations (user_id, agent_id, kind, severity, subject_kind, "
            "subject_ref, headline, explanation, evidence, dedupe_key, narration_source, "
            "created_at) VALUES (CAST(:u AS uuid), CAST(:a AS uuid), 'drawdown', :severity, "
            "'instrument', 'instrument:SMR', :headline, :explanation, CAST(:evidence AS jsonb), "
            "'eval:drawdown:SMR', 'template', :at)"
        ),
        {
            "u": account.user_id,
            "a": account.primary_id,
            "severity": finding.severity,
            "headline": f"SMR is {decline}% below its {finding.evidence['window_days']}-day high",
            "explanation": (
                f"SMR closed {decline}% below the highest close of the last "
                f"{finding.evidence['window_days']} days."
            ),
            "evidence": json.dumps(finding.evidence),
            "at": now - timedelta(days=1),
        },
    )


def _topic(connection: Connection, account: Account, now: datetime) -> None:
    topic = connection.execute(
        text(
            "INSERT INTO topics (user_id, label, status, created_by, confirmed_at, created_at) "
            "VALUES (CAST(:u AS uuid), :label, 'active', 'user', :at, :at) RETURNING id::text"
        ),
        {"u": account.user_id, "label": TOPIC, "at": now - timedelta(days=21)},
    ).scalar_one()
    for symbol, rationale in TOPIC_MEMBERS.items():
        connection.execute(
            text(
                "INSERT INTO topic_instruments (topic_id, user_id, instrument_id, source, "
                "confidence, rationale) VALUES (CAST(:t AS uuid), CAST(:u AS uuid), "
                "CAST(:i AS uuid), 'resolver', 'confident', :r)"
            ),
            {
                "t": topic,
                "u": account.user_id,
                "i": _instrument(connection, symbol),
                "r": rationale,
            },
        )
    connection.execute(
        text(
            "INSERT INTO observations (user_id, agent_id, kind, severity, subject_kind, "
            "subject_ref, headline, evidence, dedupe_key, narration_source, created_at) "
            "VALUES (CAST(:u AS uuid), CAST(:a AS uuid), 'topic_move', 'notable', 'topic', "
            ":ref, :headline, CAST(:evidence AS jsonb), 'eval:topic_move', 'template', :at)"
        ),
        {
            "u": account.user_id,
            "a": account.primary_id,
            "ref": f"topic:{topic}",
            "headline": f"{TOPIC} rose 4.80% over five days",
            "evidence": json.dumps({"topic": TOPIC, "change_pct": "4.80", "window_days": 5}),
            "at": now - timedelta(days=2),
        },
    )
