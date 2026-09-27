"""News provider contract.

The news half of guideline 6, and a deliberate echo of
`app/providers/base.py`: same shape, same vocabulary, same promises, so that
whoever learns one layer has already learned the other. A provider declares its
name and what a call to it costs, returns what it can, and raises
`NewsProviderError` to mean "unusable right now" so the chain can move on.

Two differences from the market-data contract, both forced by what news is:

  * There is no cache-granularity knob. A quote has an observation time we can
    floor to a freshness window (`quote_granularity_seconds`); an article has a
    publication time that belongs to the publisher, and rounding it would misdate
    the event. Dedupe is done by content hash instead - see `app/news/dedupe.py`.
  * `fetch_for_query` exists beside `fetch_for_symbols` because Milestone 5's
    topics are free text (FR-10) and a symbol list cannot express "small modular
    reactors". Both return the same type, so the pipeline treats them alike.

A provider returns `RawArticle`s and nothing more: no entity links, no sentiment,
no relevance judgement. Even when the upstream API was queried per symbol and
therefore "knows" which symbol an article belongs to, that association is not
passed through, because an API's idea of relevance is an unauditable link we
would then be storing as evidence. Every link in this system is made by
`app/news/entities.py`, by a rule that can be named in a column.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Protocol, runtime_checkable

from app.news.article import RawArticle


class NewsProviderError(RuntimeError):
    """Raised for any provider-side failure. The pipeline catches it and moves on.

    `partial` carries what the provider did fetch before it failed. A provider that
    splits one call into several upstream requests (GDELT reads one file per 15
    minutes) can fail on the fifth after four succeeded, and discarding those
    would turn a partial feed into an empty one. The failure still marks the run
    degraded; the articles are kept.
    """

    def __init__(self, provider: str, message: str, *, partial: Sequence[RawArticle] = ()) -> None:
        super().__init__(f"{provider}: {message}")
        self.provider = provider
        self.partial: list[RawArticle] = list(partial)


@runtime_checkable
class NewsProvider(Protocol):
    #: Stable identifier, recorded on every article as `source` when the upstream
    #: does not name an outlet of its own.
    name: str

    #: Does calling this provider consume an external quota? False for
    #: FixtureNewsProvider, which reads a local JSON file. The chain skips rate
    #: limiting entirely for such providers, so an offline demo cannot lock
    #: itself out of its own fixtures.
    makes_external_requests: bool

    #: Does `fetch_for_symbols` cover the whole list in one upstream request?
    #: False for the per-symbol news endpoints most vendors ship. This is what a
    #: limiter must charge against: a 14-symbol scan costs 14 requests from a
    #: non-batching provider and 1 from a batching one, and charging 1 for both
    #: under-reports usage by the batch size - the bug the market-data layer
    #: already paid for.
    batches_requests: bool

    async def fetch_for_symbols(
        self,
        symbols: list[str],
        since: datetime,
        *,
        limit: int | None = None,
        names: Mapping[str, Sequence[str]] | None = None,
    ) -> list[RawArticle]:
        """Articles plausibly about `symbols`, published at or after `since`.

        "Plausibly" is the provider's own view and is not trusted: the pipeline
        decides what an article is about. Returning too much is safe, and
        returning nothing is a valid answer - raising is reserved for a provider
        that is broken.

        `names` maps a symbol to the spellings the entity matcher links it by.
        A per-symbol news API can ignore it; a provider that filters headlines
        itself (GDELT) cannot work without it, because "NVDA" rarely appears in
        prose and "Nvidia" does. Added when the first such provider arrived, as an optional keyword
        so no existing provider changed.
        """
        ...

    async def fetch_for_query(
        self,
        query: str,
        since: datetime,
        *,
        limit: int | None = None,
    ) -> list[RawArticle]:
        """Articles matching a free-text query, published at or after `since`."""
        ...
