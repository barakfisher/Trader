"""The offline news provider, and the cases its corpus is required to contain.

`data/fixtures/news.json` is test data with obligations: the pipeline's hard cases
have to be in it or nothing exercises them. The last class here asserts those
obligations, so deleting the awkward articles breaks a test instead of quietly
reducing the coverage of everything downstream.
"""

import json
from datetime import UTC, datetime
from pathlib import Path

from app.news.dedupe import content_hash, url_hash
from app.news.entities import EntityMatcher
from app.news.fixture import FixtureNewsProvider

#: The corpus is dated September 2026; `since` values here bracket that window.
BEFORE_CORPUS = datetime(2026, 1, 1, tzinfo=UTC)
MID_CORPUS = datetime(2026, 9, 16, tzinfo=UTC)
AFTER_CORPUS = datetime(2027, 1, 1, tzinfo=UTC)

DEMO_SYMBOLS = ["AAPL", "MSFT", "NVDA", "GOOGL", "SMR", "CEG", "VOO", "QQQ", "URA", "TAN"]


class TestProviderContract:
    def test_it_declares_itself_offline(self, news_provider: FixtureNewsProvider):
        # The limiter skips providers with no upstream to protect; an offline demo
        # must not be able to rate-limit itself out of its own fixtures.
        assert news_provider.makes_external_requests is False

    async def test_it_returns_the_corpus_for_a_window_that_contains_it(
        self, news_provider: FixtureNewsProvider
    ):
        articles = await news_provider.fetch_for_symbols(DEMO_SYMBOLS, BEFORE_CORPUS)
        assert len(articles) >= 15

    async def test_since_is_honoured_literally(self, news_provider: FixtureNewsProvider):
        # A fixture that re-dated its articles to "just now" would make every test
        # involving a window meaningless.
        assert await news_provider.fetch_for_symbols(DEMO_SYMBOLS, AFTER_CORPUS) == []

    async def test_a_narrower_window_returns_fewer_articles(
        self, news_provider: FixtureNewsProvider
    ):
        everything = await news_provider.fetch_for_symbols(DEMO_SYMBOLS, BEFORE_CORPUS)
        recent = await news_provider.fetch_for_symbols(DEMO_SYMBOLS, MID_CORPUS)
        assert 0 < len(recent) < len(everything)
        assert all(article.published_at >= MID_CORPUS for article in recent)

    async def test_articles_come_back_newest_first(self, news_provider: FixtureNewsProvider):
        articles = await news_provider.fetch_for_symbols(DEMO_SYMBOLS, BEFORE_CORPUS)
        stamps = [article.published_at for article in articles]
        assert stamps == sorted(stamps, reverse=True)

    async def test_limit_is_applied(self, news_provider: FixtureNewsProvider):
        articles = await news_provider.fetch_for_symbols(DEMO_SYMBOLS, BEFORE_CORPUS, limit=3)
        assert len(articles) == 3

    async def test_free_text_query_searches_title_and_body(
        self, news_provider: FixtureNewsProvider
    ):
        # The shape Milestone 5's free-text topics need (FR-10).
        matches = await news_provider.fetch_for_query("uranium", BEFORE_CORPUS)
        assert len(matches) >= 1
        assert all("uranium" in f"{item.title} {item.body}".lower() for item in matches)
        assert await news_provider.fetch_for_query("no such phrase anywhere", BEFORE_CORPUS) == []

    def test_a_missing_fixture_file_degrades_to_an_empty_corpus(self, tmp_path):
        # A scheduled run must not crash because a file is absent.
        assert FixtureNewsProvider(str(tmp_path))._articles == []


class TestCorpusObligations:
    """What the fixture has to contain for the pipeline's tests to mean anything."""

    async def test_it_marks_itself_as_fictional(self, settings):
        payload = json.loads((Path(settings.fixtures_dir) / "news.json").read_text())
        assert "FICTIONAL" in payload["_comment"]

    async def test_it_contains_two_near_duplicate_stories_at_different_urls(
        self, news_provider: FixtureNewsProvider
    ):
        articles = await news_provider.fetch_for_symbols(DEMO_SYMBOLS, BEFORE_CORPUS)
        by_content: dict[str, set[str]] = {}
        for article in articles:
            by_content.setdefault(content_hash(article.body), set()).add(url_hash(article.url))
        shared = [urls for urls in by_content.values() if len(urls) > 1]
        assert len(shared) == 1, "expected exactly one syndicated pair in the corpus"

    async def test_every_url_in_the_corpus_is_distinct(self, news_provider: FixtureNewsProvider):
        articles = await news_provider.fetch_for_symbols(DEMO_SYMBOLS, BEFORE_CORPUS)
        assert len({url_hash(article.url) for article in articles}) == len(articles)

    async def test_it_contains_an_article_that_mentions_several_holdings(
        self, news_provider: FixtureNewsProvider, matcher: EntityMatcher
    ):
        articles = await news_provider.fetch_for_symbols(DEMO_SYMBOLS, BEFORE_CORPUS)
        counts = [len(matcher.match(item.title, item.body)) for item in articles]
        assert max(counts) >= 3

    async def test_it_contains_articles_that_mention_nothing_we_hold(
        self, news_provider: FixtureNewsProvider, matcher: EntityMatcher
    ):
        articles = await news_provider.fetch_for_symbols(DEMO_SYMBOLS, BEFORE_CORPUS)
        unmatched = [item for item in articles if not matcher.match(item.title, item.body)]
        # The macro story and the SMR notice: one that mentions no holding, and one
        # whose ticker-shaped word is not a ticker.
        assert len(unmatched) >= 2

    async def test_the_ticker_shaped_word_article_is_in_the_corpus_and_links_nothing(
        self, news_provider: FixtureNewsProvider, matcher: EntityMatcher
    ):
        articles = await news_provider.fetch_for_symbols(DEMO_SYMBOLS, BEFORE_CORPUS)
        notices = [item for item in articles if "SMR" in item.title]
        assert len(notices) == 1
        assert matcher.match(notices[0].title, notices[0].body) == []
