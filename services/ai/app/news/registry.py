"""Building the news provider chain from configuration.

The counterpart of `build_providers` in `app/providers/registry.py`, and
deliberately the same shape: an ordered chain from `NEWS_PROVIDERS`, an unknown
name logged rather than ignored, and an empty chain refused at boot instead of
discovered as "no news today" three weeks later.

What lives here and what does not: this module decides *which* providers exist;
`app/news/ingestion.py` decides what happens when one of them fails. The
market-data layer puts its cache and rate limiter in the registry because every
caller of a quote wants both. News is fetched by one caller - the scheduled run -
and the natural unit of work is a pass over the chain, so the fallback lives with
the pass. A network news provider will bring `CACHE_TTL_NEWS` and the limiter
with it; the fixture provider needs neither (`makes_external_requests = False`).
"""

from __future__ import annotations

from app.config import Settings
from app.core.logging import get_logger
from app.news.base import NewsProvider
from app.news.fixture import FixtureNewsProvider

log = get_logger("news.registry")


def build_news_providers(settings: Settings) -> list[NewsProvider]:
    """Instantiate the configured chain, in the configured order."""
    providers: list[NewsProvider] = []
    for name in settings.news_chain:
        if name == "fixture":
            providers.append(FixtureNewsProvider(settings.fixtures_dir))
        else:
            # newsapi, gdelt and the rest plug in here as they are implemented.
            # An unknown name is a configuration mistake worth surfacing: silently
            # dropping it would leave a deployment convinced it has news.
            log.warning("news.registry.unknown_provider", provider=name)
    if not providers:
        raise ValueError("NEWS_PROVIDERS resolved to an empty chain")
    log.info("news.registry.chain", chain=[provider.name for provider in providers])
    return providers
