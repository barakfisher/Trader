"""GDELT DOC 2.0: keyless full-text news search, the first network news provider.

Chosen over NewsAPI (user, 2026-09-27) because it needs no key and its terms do
not restrict it to development use. Three properties of the API shape this
module, and each was checked against a live response rather than the docs:

  * **It searches text, not tickers.** "NVDA" rarely appears in prose. So the
    query is built from `names` - the exact spellings `app/news/entities.py` will
    link an instrument by - and a symbol with no usable name is not searched at
    all rather than searched uselessly. Fetching by any other spelling would
    return articles the matcher can never link.
  * **It returns headlines, not articles.** An `ArtList` row has a url, a title,
    a domain and the time GDELT first saw it; no body. The headline is used as the
    body, so the matcher and the sentiment lexicon read the only text there is.
    This is stated rather than hidden: sentiment from a headline is thinner than
    sentiment from an article, and `content_hash` then identifies a headline, which
    collapses syndicated copies of one story - the dedupe working as intended.
  * **It throttles hard, and says so in plain text.** More than one request per
    five seconds gets a 429 whose body is an English sentence, not JSON; the same
    sentence has been seen with other statuses. Anything that is not a JSON object
    is therefore a `NewsProviderError`, so the run records a provider failure and
    is `degraded`, never an empty feed that reads as a quiet day. Requests within
    one fetch are spaced by `min_interval_seconds`.
  * **Its 429 is mostly load-shedding, not a verdict on us.** Measured on
    2026-09-27: requests 20 s and 30 min apart were refused alike, one plain query
    succeeded and the identical URL was refused two minutes later, and every reply
    took 11-15 s. So a throttled request is retried after `retry_delays_seconds`,
    and a batch that still fails does not discard the batches before it: they go
    out on `NewsProviderError.partial`, and the run is degraded rather than empty.

`published_at` is GDELT's `seendate`: when its crawler first saw the article. It
is not the publisher's timestamp, and it is used because it is the closest honest
time available - usually minutes after publication - and a null would drop the
article from every windowed read.
"""

from __future__ import annotations

import asyncio
import math
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

import httpx

from app.core.logging import get_logger
from app.news.article import RawArticle
from app.news.base import NewsProviderError

log = get_logger("news.gdelt")

GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc"

#: GDELT asks for at most one request every five seconds. Half a second of margin.
GDELT_MIN_INTERVAL_SECONDS = 5.5

#: Names OR'd into one query. Long queries are rejected by the API; eight quoted
#: names stays well inside what it accepts, and keeps a dozen instruments to two
#: requests.
GDELT_TERMS_PER_REQUEST = 8

#: GDELT refuses phrases this short or shorter as "too short".
GDELT_MIN_TERM_LENGTH = 3

#: The API's own ceiling on `maxrecords`.
GDELT_MAX_RECORDS = 250
GDELT_DEFAULT_RECORDS = 75

GDELT_TIMEOUT_SECONDS = 30.0

#: Waits before the second and third attempt at a refused request. A refusal has
#: taken 11-15 s, so a refused request costs about 80 s in all, and a dozen
#: instruments (two requests) stays inside the orchestrator's collect timeout.
GDELT_RETRY_DELAYS_SECONDS: tuple[float, ...] = (10.0, 30.0)

#: The throttle notice, which has also been seen with a 200.
GDELT_THROTTLE_MARKER = "limit requests"


class _Refused(NewsProviderError):
    """A failure worth retrying: throttled, a server error, or no reply at all."""


class GdeltNewsProvider:
    name = "gdelt"
    makes_external_requests = True
    # One request covers up to GDELT_TERMS_PER_REQUEST instruments, not all of
    # them, so a limiter must charge per request - which is why the spacing
    # lives here, where the request count is known.
    batches_requests = False

    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        min_interval_seconds: float = GDELT_MIN_INTERVAL_SECONDS,
        retry_delays_seconds: Sequence[float] = GDELT_RETRY_DELAYS_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        # Injected by tests as an httpx.MockTransport, which keeps the suite
        # hermetic: no test of this module reaches the network.
        self._transport = transport
        self._min_interval = min_interval_seconds
        self._retry_delays = tuple(retry_delays_seconds)
        self._sleep = sleep
        self._clock = clock
        self._last_request: float | None = None

    async def fetch_for_symbols(
        self,
        symbols: list[str],
        since: datetime,
        *,
        limit: int | None = None,
        names: Mapping[str, Sequence[str]] | None = None,
    ) -> list[RawArticle]:
        terms = query_terms(symbols, names or {})
        if not terms:
            # Nothing searchable is an answer, not a failure: a portfolio of
            # instruments with no names has no text for GDELT to find.
            log.info("news.gdelt.no_terms", symbols=len(symbols))
            return []
        articles: list[RawArticle] = []
        for start in range(0, len(terms), GDELT_TERMS_PER_REQUEST):
            chunk = terms[start : start + GDELT_TERMS_PER_REQUEST]
            try:
                articles.extend(await self._search(_or_query(chunk), since, limit))
            except NewsProviderError as exc:
                # Later batches are not attempted: GDELT has just refused three
                # times, and more requests into a refusing server buy nothing.
                log.warning(
                    "news.gdelt.batch_failed",
                    batch=start // GDELT_TERMS_PER_REQUEST,
                    kept=len(articles),
                )
                exc.partial = articles
                raise
        return articles

    async def fetch_for_query(
        self,
        query: str,
        since: datetime,
        *,
        limit: int | None = None,
    ) -> list[RawArticle]:
        phrase = query.strip().replace('"', "")
        if len(phrase) <= GDELT_MIN_TERM_LENGTH:
            return []
        return await self._search(_or_query([phrase]), since, limit)

    async def _search(self, query: str, since: datetime, limit: int | None) -> list[RawArticle]:
        now = self._clock().astimezone(UTC)
        hours = max(1, math.ceil((now - since.astimezone(UTC)).total_seconds() / 3600))
        params = {
            "query": f"{query} sourcelang:english",
            "mode": "ArtList",
            "format": "json",
            "sort": "DateDesc",
            "maxrecords": str(min(limit or GDELT_DEFAULT_RECORDS, GDELT_MAX_RECORDS)),
            "timespan": f"{hours}h",
        }
        for attempt, delay in enumerate(self._retry_delays, start=1):
            try:
                return self._articles(await self._request(params), since)
            except _Refused as exc:
                log.info("news.gdelt.retry", attempt=attempt, delay=delay, error=str(exc))
                await self._sleep(delay)
        # The last attempt: a refusal here is the provider's failure.
        return self._articles(await self._request(params), since)

    async def _request(self, params: dict[str, str]) -> dict[str, Any]:
        await self._space_requests()
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=GDELT_TIMEOUT_SECONDS
            ) as client:
                response = await client.get(GDELT_DOC_URL, params=params)
        except httpx.HTTPError as exc:
            raise _Refused(self.name, f"request failed: {exc.__class__.__name__}") from exc
        finally:
            self._last_request = time.monotonic()

        payload = _json_object(response)
        if response.status_code != 200 or payload is None:
            # The throttle notice is prose; quote its start so the log says why.
            message = f"HTTP {response.status_code}: {response.text[:80].strip()}"
            retryable = (
                response.status_code == 429
                or response.status_code >= 500
                or GDELT_THROTTLE_MARKER in response.text
            )
            # Anything else (a query GDELT calls malformed) fails the same way
            # every time, so it is not retried.
            raise (_Refused if retryable else NewsProviderError)(self.name, message)
        return payload

    def _articles(self, payload: dict[str, Any], since: datetime) -> list[RawArticle]:
        rows = payload.get("articles") or []
        articles = [article for row in rows if (article := _to_article(row)) is not None]
        cutoff = since.astimezone(UTC)
        return [a for a in articles if a.published_at is None or a.published_at >= cutoff]

    async def _space_requests(self) -> None:
        if self._last_request is None:
            return
        wait = self._min_interval - (time.monotonic() - self._last_request)
        if wait > 0:
            await self._sleep(wait)


def query_terms(symbols: Sequence[str], names: Mapping[str, Sequence[str]]) -> list[str]:
    """One search phrase per instrument: its shortest name alias.

    The shortest because a phrase search for "Valero" also finds "Valero Energy",
    and the matcher accepts either. Deduplicated case-insensitively, in symbol
    order, so the request split is stable from run to run.
    """
    seen: set[str] = set()
    terms: list[str] = []
    for symbol in symbols:
        aliases = [
            alias.replace('"', "").strip()
            for alias in names.get(symbol, ())
            if len(alias.strip()) > GDELT_MIN_TERM_LENGTH
        ]
        if not aliases:
            continue
        term = min(aliases, key=len)
        if term.lower() not in seen:
            seen.add(term.lower())
            terms.append(term)
    return terms


def _or_query(terms: Sequence[str]) -> str:
    quoted = [f'"{term}"' for term in terms]
    # GDELT requires OR'd terms in parentheses and rejects parentheses around one.
    return quoted[0] if len(quoted) == 1 else f"({' OR '.join(quoted)})"


def _json_object(response: httpx.Response) -> dict[str, Any] | None:
    try:
        payload = response.json()
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


def _to_article(row: object) -> RawArticle | None:
    if not isinstance(row, dict):
        return None
    url = str(row.get("url") or "").strip()
    title = str(row.get("title") or "").strip()
    if not url or not title:
        return None
    return RawArticle(
        url=url,
        source=str(row.get("domain") or "gdelt"),
        title=title,
        # Headlines only: see the module docstring.
        body=title,
        published_at=_seen_at(row.get("seendate")),
    )


def _seen_at(value: object) -> datetime | None:
    """`20260927T101500Z` -> an aware UTC datetime; anything else -> None."""
    try:
        return datetime.strptime(str(value), "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
    except ValueError:
        return None
