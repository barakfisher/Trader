"""What a research rating may cite, gathered by the server for one holding (D254, D291).

A scan lets the model choose its tools (D15); research does not. Its cost is
"about one model call per holding" (D254), so the server reads the same sources
an agent's tools read, once, and the model is handed the result:

- **the quote** and **price history** (`get_quote`, `get_price_history`): the
  market data;
- **the rule findings** (`get_findings`): moves, sigma moves and drawdowns the
  analysis rules found;
- **recent news** (`get_news`) with each article's stored lexicon score
  (`article_sentiment`), and their average;
- **the sector**: the instrument's sector and industry, and the average stored
  sentiment of the last week's articles about other instruments in the same
  sector - the sector's trend, read from what is already stored;
- **the market**: the benchmark's recent change, read once per run.

Every figure in the rating must be found here (guideline 7), so this mapping
is also what the evidence validator checks against, and it is stored with the
rating. The holding's quantity and cost are deliberately absent: the rating is
about the stock, never the position (guardrail 1).
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import text

from app.agents.tools import (
    ToolContext,
    find_listing,
    get_findings,
    get_news,
    get_price_history,
    get_quote,
)

#: Days of news a rating reads: the most `get_news` allows.
NEWS_DAYS = 7
#: Trading days of price history.
HISTORY_DAYS = 60
#: The benchmark the market's trend is read from, when it is listed.
MARKET_BENCHMARK = "SPY"
#: Trading days of the benchmark's history.
MARKET_DAYS = 20


def _average(scores: list[Decimal]) -> str | None:
    if not scores:
        return None
    return f"{(sum(scores) / len(scores)).quantize(Decimal('0.01')).normalize():f}"


def _sector(context: ToolContext, instrument_id: str) -> dict[str, Any] | None:
    """The instrument's sector and industry, and the sector's news sentiment this week."""
    since = context.now - timedelta(days=NEWS_DAYS)
    with context.engine.connect() as connection:
        profile = connection.execute(
            text(
                "SELECT sector, industry FROM instrument_profiles "
                "WHERE instrument_id = CAST(:instrument AS uuid)"
            ),
            {"instrument": instrument_id},
        ).one_or_none()
        if profile is None or profile.sector is None:
            return None
        peers = connection.execute(
            text(
                """
                SELECT count(DISTINCT a.id) AS articles, avg(s.score) AS score
                  FROM instrument_profiles p
                  JOIN article_entities e ON e.instrument_id = p.instrument_id
                  JOIN articles a ON a.id = e.article_id AND a.duplicate_of_id IS NULL
                  JOIN article_sentiment s ON s.article_id = a.id
                 WHERE p.sector = :sector
                   AND p.instrument_id <> CAST(:instrument AS uuid)
                   AND a.published_at >= :since
                """
            ),
            {"sector": profile.sector, "instrument": instrument_id, "since": since},
        ).one()
    score = None if peers.score is None else Decimal(peers.score)
    return {
        "sector": profile.sector,
        "industry": profile.industry,
        "sector_news_articles_7d": int(peers.articles),
        "sector_news_sentiment_7d": (
            None if score is None else f"{score.quantize(Decimal('0.01')).normalize():f}"
        ),
    }


async def market_evidence(context: ToolContext) -> dict[str, Any] | None:
    """The benchmark's recent trend, read once per run; None when it is not listed."""
    if find_listing(context.engine, MARKET_BENCHMARK) is None:
        return None
    history = await get_price_history(context, {"symbol": MARKET_BENCHMARK, "days": MARKET_DAYS})
    if not history.get("closes"):
        return None
    return {
        "benchmark": MARKET_BENCHMARK,
        "trading_days": history.get("trading_days"),
        "change_percent": history.get("change_percent"),
        "last_close": history.get("last_close"),
        "last_close_date": history.get("last_close_date"),
    }


async def holding_evidence(
    context: ToolContext,
    *,
    instrument_id: str,
    symbol: str,
    name: str | None,
    market: dict[str, Any] | None,
) -> dict[str, Any]:
    """Everything one holding's rating may cite."""
    quote = await get_quote(context, {"symbols": [symbol]})
    history = await get_price_history(context, {"symbol": symbol, "days": HISTORY_DAYS})
    history.pop("closes", None)
    findings = await get_findings(context, {"symbol": symbol})
    news = await get_news(context, {"symbol": symbol, "days": NEWS_DAYS})
    scores = [
        Decimal(article["sentiment"])
        for article in news.get("articles", [])
        if article.get("sentiment") is not None
    ]
    return {
        "symbol": symbol,
        "name": name,
        "as_of": context.now.isoformat(),
        "quote": quote.get("quotes", {}).get(symbol),
        "price_history": history,
        "findings": findings.get("findings", []),
        "news": {
            "days": NEWS_DAYS,
            "articles": news.get("articles", []),
            "average_sentiment": _average(scores),
            "sentiment_scale": "each article's lexicon score, from -1 (negative) to 1 (positive)",
        },
        "sector": _sector(context, instrument_id),
        "market": market,
    }
