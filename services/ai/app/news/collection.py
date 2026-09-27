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
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from app.news.base import NewsProvider
from app.news.entities import EntityMatcher, InstrumentRef
from app.news.ingestion import NewsIngestion
from app.news.queries import load_known_hashes, store_ingested
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
    return stats
