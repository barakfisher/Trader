"""Offline news provider backed by a JSON fixture.

The counterpart of `app/providers/fixture.py`: what CI, the test suite and the
zero-API-key demo run on. A real provider implementation rather than a mock - the
same protocol, the same pipeline behind it - which is what makes the demo's news
worth looking at.

`fetch_for_symbols` ignores its `symbols` argument, which looks like a bug and is
the point. `data/fixtures/news.json` is already scoped to the demo portfolio, and
a fixture that filtered by symbol would have to decide which articles are about
which instrument - which is exactly the judgement `app/news/entities.py` exists to
make, and the judgement the tests exist to check. It would also hide the two cases
that matter most: the article that mentions nothing we hold, and the one whose
ticker-shaped word is not a ticker, would never reach the pipeline at all. So the
fixture behaves like an upstream with a generous relevance filter, which is also
how the real ones behave.

The fixture's dates are fixed rather than relative to now. `since` is honoured
literally, so a window that does not include the fixture's month returns nothing.
A provider that re-dated every article to "just now" would be more convenient and
would make every test that involves a window meaningless.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from app.core.logging import get_logger
from app.news.article import RawArticle

log = get_logger("news.fixture")

FIXTURE_FILENAME = "news.json"


class FixtureNewsProvider:
    name = "fixture"
    makes_external_requests = False
    batches_requests = True

    def __init__(self, fixtures_dir: str) -> None:
        self._dir = Path(fixtures_dir)
        self._articles: list[RawArticle] = []
        self._load()

    def _load(self) -> None:
        path = self._dir / FIXTURE_FILENAME
        if not path.exists():
            # Same stance as the market-data fixture: a missing file degrades to
            # an empty corpus, never to a crash on a scheduled run.
            log.warning("news.fixture.missing_file", path=str(path))
            return
        payload = json.loads(path.read_text())
        self._articles = [_to_article(item) for item in payload.get("articles", [])]
        log.info("news.fixture.loaded", articles=len(self._articles))

    async def fetch_for_symbols(
        self,
        symbols: list[str],
        since: datetime,
        *,
        limit: int | None = None,
    ) -> list[RawArticle]:
        return self._window(since, limit)

    async def fetch_for_query(
        self,
        query: str,
        since: datetime,
        *,
        limit: int | None = None,
    ) -> list[RawArticle]:
        needle = query.strip().lower()
        if not needle:
            return self._window(since, limit)
        matches = [
            article
            for article in self._window(since, None)
            if needle in article.title.lower() or needle in article.body.lower()
        ]
        return matches[:limit] if limit is not None else matches

    def _window(self, since: datetime, limit: int | None) -> list[RawArticle]:
        """Articles published at or after `since`, newest first.

        An article with no `published_at` is kept: it cannot be shown to be
        outside the window, and dropping it would throw away a story because its
        publisher omitted a field. Dedupe stops it from being re-ingested.
        """
        cutoff = since.astimezone(UTC)
        selected = [
            article
            for article in self._articles
            if article.published_at is None or article.published_at >= cutoff
        ]
        selected.sort(key=_sort_key, reverse=True)
        return selected[:limit] if limit is not None else selected


def _sort_key(article: RawArticle) -> datetime:
    #: Undated articles sort oldest, so a `limit` keeps the dated ones first.
    return article.published_at or datetime.min.replace(tzinfo=UTC)


def _to_article(item: dict) -> RawArticle:
    published_at = item.get("published_at")
    return RawArticle(
        url=item["url"],
        source=item["source"],
        title=item["title"],
        body=item["body"],
        published_at=datetime.fromisoformat(published_at) if published_at else None,
    )
