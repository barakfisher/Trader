"""The news half of the analysis pipeline (DESIGN.md section 5, step 4).

The second input to the engine. The rule layer in `app/analysis` answers "what
moved"; this package gathers the material that later answers "why did it move?".

The layering is strict and worth stating once:

  * `base` is the provider contract and `fixture` the offline implementation of
    it, mirroring `app/providers` so the two layers read the same way;
  * `article` owns the data at each stage, `dedupe` owns identity, `entities`
    owns what an article is about, `sentiment` owns tone;
  * `ingestion` composes those four into one pass and is the only module that
    knows the order they run in;
  * `queries` is the only module here that knows SQL exists.

Everything except `queries` and the providers is a pure function of its inputs:
no clock, no database, no configuration lookup, and no network anywhere in the
package when the chain is `fixture`.
"""

from app.news.article import ArticleRecord, IngestedArticle, RawArticle
from app.news.base import NewsProvider, NewsProviderError
from app.news.entities import EntityLink, EntityMatcher, InstrumentRef
from app.news.fixture import FixtureNewsProvider
from app.news.ingestion import IngestionResult, KnownHashes, NewsIngestion
from app.news.registry import build_news_providers
from app.news.sentiment import LexiconSentimentScorer, SentimentScore, SentimentScorer

__all__ = [
    "ArticleRecord",
    "EntityLink",
    "EntityMatcher",
    "FixtureNewsProvider",
    "IngestedArticle",
    "IngestionResult",
    "InstrumentRef",
    "KnownHashes",
    "LexiconSentimentScorer",
    "NewsIngestion",
    "NewsProvider",
    "NewsProviderError",
    "RawArticle",
    "SentimentScore",
    "SentimentScorer",
    "build_news_providers",
]
