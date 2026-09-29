"""One scheduled collection: the pass `ingestion` describes, run and stored.

`ingestion.py` is pure and `queries.py` is SQL; this module is the one place
that joins them to a clock and a connection, and it is what the `news_collect`
run calls. It exists because until it did, nothing called either - the corpus
was built, tested and permanently empty.

**Who is matched.** The matcher is built from the instruments the caller names,
which the orchestrator restricts to what the user holds and what their active
topics contain. Never the 5,294-instrument universe: company names such as
"Target", "Block" and "Visa" are ordinary words, and a matcher that knew all of
them would link half of every article to something. The narrower list is not a
performance choice; it is the difference between a link that means "this is
about something you follow" and one that means "this contains a noun".

**The window.** Articles published within `lookback` of now. The known-hash set
is loaded over the same window by fetch time, which is enough: an article
fetched before the window opened cannot be re-fetched inside it unless its
publisher re-dated it, and then `ON CONFLICT (url_hash)` still stops the copy.

**The market feed's upkeep** (decision 60), done here because this is the run
that grows it. Unlinked market articles older than `market_retention` are
deleted: the caller sets it to discovery's window plus a proposal's lifetime, so
everything behind an open proposal can still be read. And the last
`SUSPECT_WINDOW` of market headlines is checked for outlets that look like a
ticker network not yet listed, reported in the stats for a person to judge.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from app.news.base import NewsProvider
from app.news.entities import EntityMatcher, InstrumentRef, name_aliases
from app.news.ingestion import NewsIngestion
from app.news.market_feed import SUSPECT_WINDOW, suspected_networks
from app.news.queries import (
    load_known_hashes,
    load_market_headlines,
    prune_market_articles,
    store_ingested,
)
from app.news.sentiment import SentimentScorer


async def collect_news(
    connection: object,
    providers: list[NewsProvider],
    scorer: SentimentScorer,
    instruments: Sequence[InstrumentRef],
    *,
    lookback: timedelta,
    limit_per_provider: int | None = None,
    now: datetime | None = None,
    market_retention: timedelta | None = None,
) -> dict[str, object]:
    """Fetch, match, score and store one window. Returns the run's stats."""
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    since = moment - lookback

    pipeline = NewsIngestion(providers, EntityMatcher(list(instruments)), scorer)
    result = await pipeline.ingest(
        [instrument.symbol for instrument in instruments],
        since,
        known=load_known_hashes(connection, since=since),
        limit_per_provider=limit_per_provider,
        names={instrument.symbol: name_aliases(instrument) for instrument in instruments},
        now=moment,
    )
    inserted = store_ingested(connection, result.articles)

    stats = dict(result.stats)
    stats["inserted"] = inserted
    stats["instruments"] = len(instruments)
    stats["since"] = since.isoformat()
    # Which instruments the stored articles are about, so GET /runs answers
    # "did anything I follow make the news?" without a query.
    linked: dict[str, int] = {}
    for article in result.articles:
        for link in article.entities:
            linked[link.symbol] = linked.get(link.symbol, 0) + 1
    stats["linked_symbols"] = linked
    stats["market_articles"] = sum(1 for item in result.articles if item.record.article.market)
    # None when the caller did not say how long discovery needs them: keep all.
    stats["pruned"] = (
        prune_market_articles(connection, before=moment - market_retention)
        if market_retention is not None
        else 0
    )
    stats["suspected_networks"] = [
        {"source": s.source, "headlines": s.headlines, "templated": s.templated}
        for s in suspected_networks(
            load_market_headlines(connection, since=moment - SUSPECT_WINDOW)
        )
    ]
    return stats
