"""One pass of the news pipeline, with no network and no database.

The stub provider below is the point: the pipeline's behaviour is decided by the
articles it is handed, so every case is a list of literals rather than a fixture
of the world. The fixture corpus is exercised separately in
test_fixture_news_provider.py and once at the end of this module, where the two
meet.
"""

from datetime import UTC, datetime

import pytest

from app.news.article import RawArticle
from app.news.base import NewsProviderError
from app.news.dedupe import content_hash, url_hash
from app.news.entities import EntityMatcher
from app.news.fixture import FixtureNewsProvider
from app.news.ingestion import KnownHashes, NewsIngestion
from app.news.sentiment import LEXICON_MODEL_NAME, LexiconSentimentScorer

SINCE = datetime(2026, 1, 1, tzinfo=UTC)
FETCHED_AT = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)

WIRE_BODY = (
    "Constellation Energy Corporation ($CEG) has agreed a twenty-year power "
    "purchase agreement with an unnamed hyperscale operator."
)


def raw(url: str, title: str, body: str, source: str = "Example Newswire") -> RawArticle:
    return RawArticle(url=url, source=source, title=title, body=body, published_at=FETCHED_AT)


class StubProvider:
    """A NewsProvider that returns what a test gives it, or raises."""

    makes_external_requests = False
    batches_requests = True

    def __init__(self, name: str, articles: list, *, fails: bool = False) -> None:
        self.name = name
        self._articles = articles
        self._fails = fails
        self.calls = 0

    async def fetch_for_symbols(self, symbols, since, *, limit=None):
        self.calls += 1
        if self._fails:
            raise NewsProviderError(self.name, "upstream unavailable")
        return list(self._articles)

    async def fetch_for_query(self, query, since, *, limit=None):
        return await self.fetch_for_symbols([], since, limit=limit)


def build(providers, instruments) -> NewsIngestion:
    return NewsIngestion(providers, EntityMatcher(instruments), LexiconSentimentScorer())


class TestUrlDedupe:
    async def test_the_same_url_twice_in_one_batch_is_stored_once(self, news_instruments):
        pipeline = build(
            [
                StubProvider(
                    "a",
                    [
                        raw("https://a.example.com/x", "Apple posts record revenue", "Apple Inc."),
                        raw(
                            "https://a.example.com/x?utm_source=mail",
                            "Apple posts record revenue",
                            "Apple Inc.",
                        ),
                    ],
                )
            ],
            news_instruments,
        )
        result = await pipeline.ingest(["AAPL"], SINCE, now=FETCHED_AT)
        assert len(result.articles) == 1
        assert result.duplicate_urls == 1

    async def test_an_article_we_already_hold_is_skipped(self, news_instruments):
        known = KnownHashes(url_hashes=frozenset({url_hash("https://a.example.com/x")}))
        pipeline = build(
            [StubProvider("a", [raw("https://a.example.com/x", "Apple", "Apple Inc.")])],
            news_instruments,
        )
        result = await pipeline.ingest(["AAPL"], SINCE, known=known, now=FETCHED_AT)
        assert result.articles == []
        assert result.duplicate_urls == 1

    async def test_two_providers_carrying_the_same_link_store_it_once(self, news_instruments):
        # Every provider is queried, unlike the quote chain, because outlets
        # differ - and the overlap that buys costs nothing.
        shared = raw("https://a.example.com/x", "Apple posts record revenue", "Apple Inc.")
        first, second = StubProvider("a", [shared]), StubProvider("b", [shared])
        result = await build([first, second], news_instruments).ingest(
            ["AAPL"], SINCE, now=FETCHED_AT
        )
        assert first.calls == second.calls == 1
        assert len(result.articles) == 1
        assert result.fetched == 2


class TestContentDedupe:
    async def test_the_same_story_at_two_urls_is_kept_but_marked_as_a_copy(self, news_instruments):
        pipeline = build(
            [
                StubProvider(
                    "a",
                    [
                        raw("https://a.example.com/one", "Constellation signs deal", WIRE_BODY),
                        raw(
                            "https://b.example.net/two",
                            "Constellation inks two-decade deal",
                            WIRE_BODY.upper(),
                        ),
                    ],
                )
            ],
            news_instruments,
        )
        result = await pipeline.ingest(["CEG"], SINCE, now=FETCHED_AT)

        assert len(result.articles) == 2, "the copy's url and outlet are facts worth keeping"
        assert result.duplicate_content == 1
        original, copy = result.articles
        assert copy.is_duplicate
        assert copy.duplicate_of_url_hash == original.record.url_hash
        # One story, one signal: the copy carries no links and no opinion.
        assert copy.entities == []
        assert copy.sentiment is None
        assert original.entities and original.sentiment is not None

    async def test_a_copy_of_something_already_stored_points_at_the_stored_row(
        self, news_instruments
    ):
        known = KnownHashes(
            content_hashes={content_hash(WIRE_BODY): url_hash("https://a.example.com/one")}
        )
        pipeline = build(
            [StubProvider("a", [raw("https://b.example.net/two", "Same wire", WIRE_BODY)])],
            news_instruments,
        )
        result = await pipeline.ingest(["CEG"], SINCE, known=known, now=FETCHED_AT)
        assert result.duplicate_content == 1
        assert result.articles[0].duplicate_of_url_hash == url_hash("https://a.example.com/one")

    async def test_a_rewritten_story_is_not_a_copy(self, news_instruments):
        pipeline = build(
            [
                StubProvider(
                    "a",
                    [
                        raw("https://a.example.com/one", "Deal", WIRE_BODY),
                        raw("https://b.example.net/two", "Deal", WIRE_BODY + " Analysts agreed."),
                    ],
                )
            ],
            news_instruments,
        )
        result = await pipeline.ingest(["CEG"], SINCE, now=FETCHED_AT)
        assert result.duplicate_content == 0
        assert all(not item.is_duplicate for item in result.articles)


class TestEnrichment:
    async def test_links_and_sentiment_are_attached_to_new_articles(self, news_instruments):
        pipeline = build(
            [
                StubProvider(
                    "a",
                    [
                        raw(
                            "https://a.example.com/x",
                            "Nvidia slumps after wider export rules",
                            "NVIDIA Corporation ($NVDA) fell after the company warned and "
                            "one broker downgraded the shares.",
                        )
                    ],
                )
            ],
            news_instruments,
        )
        result = await pipeline.ingest(["NVDA"], SINCE, now=FETCHED_AT)
        item = result.articles[0]
        assert [link.symbol for link in item.entities] == ["NVDA"]
        assert item.sentiment.score < 0
        assert item.sentiment.model == LEXICON_MODEL_NAME

    async def test_an_article_matching_nothing_is_still_stored_and_scored(self, news_instruments):
        # Storing it is what makes the next pass cheap: it is deduplicated by
        # hash rather than re-matched, and topic discovery will want it later.
        pipeline = build(
            [
                StubProvider(
                    "a",
                    [
                        raw(
                            "https://a.example.com/macro",
                            "Ten-year yields ease after an inflation print lands in line",
                            "Yields eased two basis points and the curve was flat.",
                        )
                    ],
                )
            ],
            news_instruments,
        )
        result = await pipeline.ingest(["AAPL"], SINCE, now=FETCHED_AT)
        assert len(result.articles) == 1
        assert result.articles[0].entities == []
        assert result.articles[0].sentiment is not None
        assert result.stats["entity_links"] == 0

    async def test_the_fetch_time_is_the_injected_one(self, news_instruments):
        pipeline = build(
            [StubProvider("a", [raw("https://a.example.com/x", "Apple", "Apple Inc.")])],
            news_instruments,
        )
        result = await pipeline.ingest(["AAPL"], SINCE, now=FETCHED_AT)
        assert result.articles[0].record.fetched_at == FETCHED_AT

    async def test_an_empty_body_is_counted_and_dropped(self, news_instruments):
        pipeline = build(
            [StubProvider("a", [raw("https://a.example.com/x", "Headline only", "   ")])],
            news_instruments,
        )
        result = await pipeline.ingest(["AAPL"], SINCE, now=FETCHED_AT)
        assert result.articles == []
        assert result.empty_bodies == 1


class TestResilienceAndStats:
    async def test_one_broken_provider_does_not_end_the_pass(self, news_instruments):
        working = StubProvider("good", [raw("https://a.example.com/x", "Apple", "Apple Inc.")])
        result = await build(
            [StubProvider("bad", [], fails=True), working], news_instruments
        ).ingest(["AAPL"], SINCE, now=FETCHED_AT)
        assert len(result.articles) == 1
        assert result.provider_failures == ["bad"]
        assert result.providers_used == ["good"]

    async def test_stats_describe_the_pass(self, news_instruments):
        pipeline = build(
            [
                StubProvider(
                    "a",
                    [
                        raw("https://a.example.com/one", "Constellation signs deal", WIRE_BODY),
                        raw("https://b.example.net/two", "Constellation inks deal", WIRE_BODY),
                        raw("https://a.example.com/one?utm_source=x", "Dup", WIRE_BODY),
                    ],
                )
            ],
            news_instruments,
        )
        stats = (await pipeline.ingest(["CEG"], SINCE, now=FETCHED_AT)).stats
        assert stats["fetched"] == 3
        assert stats["stored"] == 2
        assert stats["duplicate_urls"] == 1
        assert stats["duplicate_content"] == 1
        assert stats["providers_used"] == ["a"]

    async def test_a_second_pass_over_unchanged_input_stores_nothing(self, news_instruments):
        # Idempotence (guideline 8), with the first pass's hashes standing in for
        # what the database would return.
        articles = [
            raw("https://a.example.com/one", "Constellation signs deal", WIRE_BODY),
            raw("https://b.example.net/two", "Constellation inks deal", WIRE_BODY),
        ]
        pipeline = build([StubProvider("a", articles)], news_instruments)
        first = await pipeline.ingest(["CEG"], SINCE, now=FETCHED_AT)
        known = KnownHashes(
            url_hashes=frozenset(item.record.url_hash for item in first.articles),
            content_hashes={
                item.record.content_hash: item.record.url_hash for item in first.articles
            },
        )
        second = await pipeline.ingest(["CEG"], SINCE, known=known, now=FETCHED_AT)
        assert second.articles == []


class TestAgainstTheFixtureCorpus:
    async def test_the_whole_corpus_ingests_into_one_signal_per_story(
        self, settings, news_instruments
    ):
        pipeline = build([FixtureNewsProvider(settings.fixtures_dir)], news_instruments)
        result = await pipeline.ingest(
            [item.symbol for item in news_instruments], SINCE, now=FETCHED_AT
        )
        # The syndicated pair is stored twice and enriched once.
        assert result.duplicate_content == 1
        assert result.duplicate_urls == 0
        enriched = [item for item in result.articles if not item.is_duplicate]
        assert len(enriched) == len(result.articles) - 1
        # Most articles link something, and some deliberately link nothing.
        linked = [item for item in enriched if item.entities]
        assert 0 < len(linked) < len(enriched)

    async def test_re_ingesting_the_corpus_adds_nothing(self, settings, news_instruments):
        pipeline = build([FixtureNewsProvider(settings.fixtures_dir)], news_instruments)
        symbols = [item.symbol for item in news_instruments]
        first = await pipeline.ingest(symbols, SINCE, now=FETCHED_AT)
        known = KnownHashes(
            url_hashes=frozenset(item.record.url_hash for item in first.articles),
            content_hashes={
                item.record.content_hash: item.record.url_hash for item in first.articles
            },
        )
        second = await pipeline.ingest(symbols, SINCE, known=known, now=FETCHED_AT)
        assert second.articles == []
        assert second.duplicate_urls == first.fetched


@pytest.mark.parametrize("bad_chain", ["", "   ", ","])
def test_an_empty_news_chain_is_refused_at_boot(bad_chain, settings):
    from app.news.registry import build_news_providers

    with pytest.raises(ValueError, match="NEWS_PROVIDERS"):
        build_news_providers(settings.model_copy(update={"news_providers": bad_chain}))
