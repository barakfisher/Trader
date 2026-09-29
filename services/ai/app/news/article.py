"""What an article is, at each stage of the news pipeline.

Three types, one per stage, so that a function's signature says how far through
the pipeline its input has travelled:

    RawArticle        what a provider returned. No hashes, no links, no opinion.
    ArticleRecord     a RawArticle plus its two dedupe hashes and a fetch time:
                      exactly the columns of the `articles` table.
    IngestedArticle   an ArticleRecord plus the entity links and the sentiment
                      derived from it: exactly what one pass of the pipeline
                      produces for one article.

These are plain frozen dataclasses rather than pydantic models on purpose. None
of them crosses the wire - no route serves news in this milestone - and keeping
them out of `app/models.py` keeps `openapi.json` and the generated TypeScript
client untouched by a change that is entirely internal.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from app.news.entities import EntityLink
from app.news.sentiment import SentimentScore


@dataclass(frozen=True, slots=True)
class RawArticle:
    """One article as a provider handed it over.

    `published_at` is optional because plenty of feeds omit it, and inventing a
    timestamp would be the news equivalent of inventing a price (guideline 7).
    An article with no publication date is stored with none and is skipped by
    anything that needs to date the event.
    """

    url: str
    source: str
    title: str
    body: str
    published_at: datetime | None = None
    #: Kept by the market feed's filter (`app/news/market_feed.py`), not only by
    #: naming something followed. Stored as `articles.feed`; it is which door the
    #: article came in by, not what it is about - that is still the matcher's call.
    market: bool = False


@dataclass(frozen=True, slots=True)
class ArticleRecord:
    """A RawArticle with the two hashes that decide whether it is new."""

    article: RawArticle
    url_hash: str
    content_hash: str
    fetched_at: datetime

    @property
    def url(self) -> str:
        return self.article.url

    @property
    def title(self) -> str:
        return self.article.title


@dataclass(frozen=True, slots=True)
class IngestedArticle:
    """One article, fully processed: stored, linked and scored.

    `duplicate_of_url_hash` is set when this article's body was already held
    under a different url. The article is kept - its url and outlet are facts -
    but it points at the first copy so that a wire story carried by five outlets
    is five rows and one signal. The column of the same name in `articles` is
    populated from this.
    """

    record: ArticleRecord
    entities: list[EntityLink] = field(default_factory=list)
    sentiment: SentimentScore | None = None
    duplicate_of_url_hash: str | None = None

    @property
    def is_duplicate(self) -> bool:
        return self.duplicate_of_url_hash is not None
