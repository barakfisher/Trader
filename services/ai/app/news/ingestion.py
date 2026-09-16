"""One pass of the news layer: fetch, deduplicate, extract entities, score.

Step 4 of the analysis pipeline (DESIGN.md section 5). The order is not
negotiable and each step earns its place before the next:

    fetch      ask every configured provider for the window
    dedupe     drop what we already hold, mark what is a copy of something else
    extract    link what survives to instruments, by rule, with the rule recorded
    score      attach a sentiment opinion, tagged with the model that formed it

Deduplicating before extracting is the whole economy of the pass: entity matching
and scoring are the expensive parts, and on a 30-minute schedule the great
majority of what a provider returns is something we saw at the last wake-up.

Unlike the market-data chain, this one queries **every** provider rather than
stopping at the first that answers. Two quote providers asked for AAPL are
answering the same question, so the second call is waste; two news providers are
not - they carry different outlets, and coverage is the point. Overlap is free
because dedupe runs immediately after, on hashes, before anything expensive.

Nothing here touches the database. The caller passes in the hashes it already
holds and persists what comes back (`app/news/queries.py` owns the SQL), which is
the same purity boundary `app/analysis` draws: this module can be tested with a
list of articles and no Postgres, and the queries can be tested against a real
table with no pipeline.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.core.logging import get_logger
from app.news.article import ArticleRecord, IngestedArticle, RawArticle
from app.news.base import NewsProvider, NewsProviderError
from app.news.dedupe import content_hash, url_hash
from app.news.entities import EntityMatcher
from app.news.sentiment import SentimentScorer

log = get_logger("news.ingestion")


@dataclass(frozen=True, slots=True)
class KnownHashes:
    """What the corpus already holds, as the pipeline needs to see it.

    `url_hashes` answers "have we stored this link?". `content_hashes` maps a
    body hash to the `url_hash` of the first article that carried it, so a
    syndicated copy can point at the original instead of being silently dropped:
    the copy's url and outlet are facts worth keeping, and one story must still
    count as one signal.

    Loaded by `app/news/queries.load_known_hashes`, restricted to the window
    being ingested. The whole corpus is not needed and would grow without bound.
    """

    url_hashes: frozenset[str] = frozenset()
    content_hashes: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class IngestionResult:
    """What one pass produced, and what it declined to produce.

    `articles` holds only rows that are new to the corpus, in the order they were
    fetched. The counters are not decoration: they are what `runs.stats` records,
    and they are the only way to tell "the feed was quiet" from "the provider
    broke" after the fact.
    """

    articles: list[IngestedArticle] = field(default_factory=list)
    fetched: int = 0
    duplicate_urls: int = 0
    duplicate_content: int = 0
    empty_bodies: int = 0
    providers_used: list[str] = field(default_factory=list)
    provider_failures: list[str] = field(default_factory=list)

    @property
    def stats(self) -> dict[str, object]:
        """A `runs.stats` payload for this pass."""
        return {
            "fetched": self.fetched,
            "stored": len(self.articles),
            "duplicate_urls": self.duplicate_urls,
            "duplicate_content": self.duplicate_content,
            "empty_bodies": self.empty_bodies,
            "entity_links": sum(len(item.entities) for item in self.articles),
            "providers_used": self.providers_used,
            "provider_failures": self.provider_failures,
        }


class NewsIngestion:
    """The pipeline. Built once per run, because the matcher compiles patterns."""

    def __init__(
        self,
        providers: list[NewsProvider],
        matcher: EntityMatcher,
        scorer: SentimentScorer,
    ) -> None:
        self._providers = providers
        self._matcher = matcher
        self._scorer = scorer

    async def ingest(
        self,
        symbols: list[str],
        since: datetime,
        *,
        known: KnownHashes | None = None,
        limit_per_provider: int | None = None,
        now: datetime | None = None,
    ) -> IngestionResult:
        """Run the pass for `symbols` over articles published at or after `since`.

        `now` is the fetch time stamped on every record, injectable so a test does
        not depend on when it runs. It is deliberately separate from an article's
        `published_at`: that one dates the event, this one dates our knowledge of
        it, and a run may only explain a price move with news it could have seen.
        """
        fetched_at = (now or datetime.now(UTC)).astimezone(UTC)
        known = known or KnownHashes()

        raw, used, failures = await self._fetch(symbols, since, limit_per_provider)
        candidates, counters = self._dedupe(raw, known, fetched_at)

        articles: list[IngestedArticle] = []
        for record, duplicate_of in candidates:
            if duplicate_of is not None:
                # A copy of something we already hold. Stored, pointed at the
                # original, and NOT matched or scored: the original carries the
                # links and the opinion, and duplicating them would let one story
                # count as several pieces of evidence for the same claim.
                articles.append(IngestedArticle(record=record, duplicate_of_url_hash=duplicate_of))
                continue
            body = record.article.body
            articles.append(
                IngestedArticle(
                    record=record,
                    entities=self._matcher.match(record.title, body),
                    sentiment=await self._scorer.score(record.title, body),
                )
            )

        result = IngestionResult(
            articles=articles,
            fetched=len(raw),
            providers_used=used,
            provider_failures=failures,
            **counters,
        )
        log.info("news.ingestion.pass", **result.stats)
        return result

    async def _fetch(
        self,
        symbols: list[str],
        since: datetime,
        limit: int | None,
    ) -> tuple[list[RawArticle], list[str], list[str]]:
        articles: list[RawArticle] = []
        used: list[str] = []
        failures: list[str] = []
        for provider in self._providers:
            try:
                batch = await provider.fetch_for_symbols(symbols, since, limit=limit)
            except NewsProviderError as exc:
                # One broken provider must not end the pass: the others still
                # carry news, and a partial feed reported as partial is worth more
                # than a failed run.
                log.warning(
                    "news.ingestion.provider_failed", provider=provider.name, error=str(exc)
                )
                failures.append(provider.name)
                continue
            used.append(provider.name)
            articles.extend(batch)
        return articles, used, failures

    def _dedupe(
        self,
        raw: list[RawArticle],
        known: KnownHashes,
        fetched_at: datetime,
    ) -> tuple[list[tuple[ArticleRecord, str | None]], dict[str, int]]:
        """Hash every article and decide what is new.

        Pure and synchronous: given the same articles and the same known hashes it
        returns the same decisions, which is what makes the rest of the pass
        idempotent. Each surviving record is paired with the `url_hash` of the
        article it is a copy of, or None when it is the first copy.
        """
        seen_urls = set(known.url_hashes)
        # Copied so this pass's own articles join the content index as it goes:
        # the second copy of a story arriving in the same batch as the first has
        # to see the first, and the database has not been written yet.
        seen_content = dict(known.content_hashes)

        candidates: list[tuple[ArticleRecord, str | None]] = []
        duplicate_urls = duplicate_content = empty_bodies = 0

        for article in raw:
            body = article.body.strip()
            if not body:
                # A headline with no text can be neither matched nor scored, and
                # storing it would put a row in the corpus that no later step can
                # use. Counted rather than logged per article: a provider whose
                # bodies are all empty shows up as a number, not as noise.
                empty_bodies += 1
                continue

            record = ArticleRecord(
                article=article,
                url_hash=url_hash(article.url),
                content_hash=content_hash(body),
                fetched_at=fetched_at,
            )
            if record.url_hash in seen_urls:
                duplicate_urls += 1
                continue
            seen_urls.add(record.url_hash)

            original = seen_content.get(record.content_hash)
            if original is None:
                seen_content[record.content_hash] = record.url_hash
            else:
                duplicate_content += 1
            candidates.append((record, original))

        return candidates, {
            "duplicate_urls": duplicate_urls,
            "duplicate_content": duplicate_content,
            "empty_bodies": empty_bodies,
        }
