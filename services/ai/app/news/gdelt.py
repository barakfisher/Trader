"""GDELT's raw 15-minute files: keyless news, read as downloads rather than searched.

**Why files, not the search API** (decision 52, user's decision 2026-09-27). The
DOC search API at api.gdeltproject.org refused most requests for a whole day
with HTTP 429 - load-shedding on GDELT's side, not a limit we could stay under -
and the one batch that got through was mostly noise: it matches a name anywhere
in an article's body but returns only the headline, so 68 of 77 stored articles
mentioned nothing followed, and its titles came back re-spaced ("U . S ."). The
raw files at data.gdeltproject.org are static downloads: the same day they
answered in 0.6 s while the API refused, and every row of the file checked had
a clean headline.

**What is read.** Every 15 minutes GDELT publishes a Global Knowledge Graph file
(`YYYYMMDDHHMMSS.gkg.csv.zip`, about 3 MB zipped, several hundred English
articles). Only five of its 27 tab-separated columns are used:

    1  DATE                the 15-minute slot the article was seen in
    3  SourceCommonName    the outlet, e.g. "reuters.com"
    4  DocumentIdentifier  the article URL
    8  V2Themes            GDELT's theme tags, read by the market feed only
    26 Extras              XML-ish extras; `<PAGE_TITLE>` holds the headline

**Headline-only matching** (user's decision). A row is kept when its headline
contains one of the name spellings `app/news/entities.py` links by (`names`).
GKG also lists the organisations an article's body mentions, and matching on
those would find more - but the headline shown, quoted and read for themes would
then not mention the thing it was kept for, which is exactly the noise the
search API produced. The headline is also the body, as before: sentiment is
headline sentiment, and it says so.

**Two filters, one read** (decision 60). With `market_feed` on, a row is also
kept when `app/news/market_feed.py` calls it market news, and is marked
`market`. Both filters see every row of the same download, so the feed costs no
extra file and the cursor stays one cursor. A market article is still matched
against the followed names like any other, so a market headline that names a
held company is linked to it.

**Which files a run reads** is a cursor (`FeedCursor`, migration 0020): the
slots after the last one read, oldest first, at most `MAX_FILES_PER_RUN`. With
no cursor yet, the last `INITIAL_WINDOW` of slots. A slot is never older than
the caller's `since`, so a stack that was down for a week does not download a
week. A file that is not there yet (404 within `PUBLISH_GRACE` of its slot) ends
the run's reading without moving the cursor, so the next run tries it again; one
missing for longer is counted and passed over, because GDELT does skip slots.

`published_at` is the slot time: when GDELT saw the article, usually minutes
after publication. It is not the publisher's timestamp, and it is the closest
honest time the file has.
"""

from __future__ import annotations

import csv
import html
import io
import re
import sys
import zipfile
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Protocol

import httpx

from app.core.logging import get_logger
from app.news.article import RawArticle
from app.news.base import NewsProviderError
from app.news.market_feed import is_excluded_outlet, is_market_headline, outlet

log = get_logger("news.gdelt")

GDELT_FILES_URL = "https://data.gdeltproject.org/gdeltv2"

#: GDELT's publishing interval, and so the spacing of the slots.
SLOT = timedelta(minutes=15)

#: Files one run may read: four hours of catch-up. Two new files arrive per
#: 30-minute run, so a gap closes at six extra files a run. About 50 MB at most.
MAX_FILES_PER_RUN = 16

#: Where a feed with no cursor starts: two hours back, not the caller's 48 -
#: 192 files would be about 600 MB for news that is mostly already a day old.
INITIAL_WINDOW = timedelta(hours=2)

#: A file not there this soon after its slot is late, not missing.
PUBLISH_GRACE = timedelta(minutes=45)

GDELT_TIMEOUT_SECONDS = 60.0

#: Columns of the GKG 2.1 file, zero-based.
_DATE, _SOURCE, _URL, _THEMES, _EXTRAS = 1, 3, 4, 8, 26
_COLUMNS = 27

_PAGE_TITLE = re.compile(r"<PAGE_TITLE>(.*?)</PAGE_TITLE>", re.DOTALL)
_SPACES = re.compile(r"\s+")

# A GKG row carries long fields (the extras, the locations); the csv module's
# default 128 KB field limit is below what the files contain.
csv.field_size_limit(sys.maxsize)


class FeedCursor(Protocol):
    """Where a file feed has read up to. `app/news/queries.py` stores it."""

    def get(self) -> datetime | None: ...

    def set(self, last_file_at: datetime) -> None: ...


class MemoryFeedCursor:
    """A cursor that lives as long as the object: tests, and a caller with no database."""

    def __init__(self, last_file_at: datetime | None = None) -> None:
        self.last_file_at = last_file_at

    def get(self) -> datetime | None:
        return self.last_file_at

    def set(self, last_file_at: datetime) -> None:
        self.last_file_at = last_file_at


@dataclass(slots=True)
class FeedPass:
    """What one read of the feed did, logged so a quiet run can be told from a broken one."""

    files_read: int = 0
    files_missing: int = 0
    rows: int = 0
    untitled: int = 0
    malformed: int = 0
    matched: int = 0
    #: Kept by the market filter (and possibly by a followed name too).
    market: int = 0
    #: Market news from an outlet in `EXCLUDED_OUTLETS`, by outlet.
    excluded: Counter[str] = field(default_factory=Counter)
    slots: list[str] = field(default_factory=list)


def slot_floor(moment: datetime) -> datetime:
    """The start of the 15-minute slot `moment` falls in, in UTC."""
    moment = moment.astimezone(UTC)
    return moment.replace(minute=moment.minute - moment.minute % 15, second=0, microsecond=0)


def slot_url(slot: datetime) -> str:
    return f"{GDELT_FILES_URL}/{slot.strftime('%Y%m%d%H%M%S')}.gkg.csv.zip"


def headline_pattern(names: Mapping[str, Sequence[str]]) -> re.Pattern[str] | None:
    """One case-insensitive, whole-word pattern over every name spelling; None if there are none."""
    spellings = sorted(
        {alias.strip() for aliases in names.values() for alias in aliases if alias.strip()},
        key=len,
        reverse=True,
    )
    if not spellings:
        return None
    alternatives = "|".join(re.escape(s) for s in spellings)
    # Grouped, or the boundaries bind only to the first and last spelling and
    # "Pineapple" matches "Apple" (caught by the test that says it must not).
    return re.compile(rf"(?<!\w)(?:{alternatives})(?!\w)", re.IGNORECASE)


def read_gkg(
    content: bytes, keep: Callable[[str], bool], stats: FeedPass, *, market: bool = False
) -> list[RawArticle]:
    """The articles in one zipped GKG file whose headline `keep` accepts, and with
    `market`, those the market feed's filter accepts too."""
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            member = archive.namelist()[0]
            text = archive.read(member).decode("utf-8", errors="replace")
    except (zipfile.BadZipFile, IndexError) as exc:
        raise ValueError("not a GKG zip") from exc

    articles: list[RawArticle] = []
    for row in csv.reader(io.StringIO(text), delimiter="\t", quoting=csv.QUOTE_NONE):
        stats.rows += 1
        if len(row) < _COLUMNS:
            stats.malformed += 1
            continue
        found = _PAGE_TITLE.search(row[_EXTRAS])
        title = _SPACES.sub(" ", html.unescape(found.group(1))).strip() if found else ""
        url = row[_URL].strip()
        if not title or not url:
            stats.untitled += 1
            continue
        source = row[_SOURCE].strip() or "gdelt"
        is_market = False
        if market and is_market_headline(title, _themes(row[_THEMES])):
            if is_excluded_outlet(source):
                stats.excluded[outlet(source)] += 1
            else:
                is_market = True
        if not is_market and not keep(title):
            continue
        stats.matched += 1
        stats.market += is_market
        articles.append(
            RawArticle(
                url=url,
                source=source,
                title=title,
                # Headlines only: see the module docstring.
                body=title,
                published_at=_slot_time(row[_DATE]),
                market=is_market,
            )
        )
    return articles


def _themes(value: str) -> set[str]:
    """`ECON_IPO,120;TAX_FNCACT_INVESTOR,57` -> the theme names; offsets dropped."""
    return {entry.split(",", 1)[0] for entry in value.split(";") if entry}


def _slot_time(value: str) -> datetime | None:
    """`20260927141500` -> an aware UTC datetime; anything else -> None."""
    try:
        return datetime.strptime(value.strip(), "%Y%m%d%H%M%S").replace(tzinfo=UTC)
    except ValueError:
        return None


class GdeltNewsProvider:
    name = "gdelt"
    makes_external_requests = True
    # A run downloads the same files whatever the instruments, so a symbol
    # list of any length costs the same.
    batches_requests = True

    def __init__(
        self,
        *,
        cursor: FeedCursor | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        market_feed: bool = False,
    ) -> None:
        # Without a stored cursor every run reads the initial window: correct,
        # just wasteful. The collection run always passes the stored one.
        self._cursor = cursor or MemoryFeedCursor()
        # Injected by tests as an httpx.MockTransport: no test reaches the network.
        self._transport = transport
        self._clock = clock
        # Off unless asked for, so a test about followed names reads only those.
        # The registry turns it on for the collection run.
        self._market_feed = market_feed

    async def fetch_for_symbols(
        self,
        symbols: list[str],
        since: datetime,
        *,
        limit: int | None = None,
        names: Mapping[str, Sequence[str]] | None = None,
    ) -> list[RawArticle]:
        pattern = headline_pattern({s: (names or {}).get(s, ()) for s in symbols})
        if pattern is None and not self._market_feed:
            # No spellings, nothing a headline could name: an answer, not a failure.
            log.info("news.gdelt.no_names", symbols=len(symbols))
            return []
        articles = await self._read(
            since,
            lambda title: pattern is not None and pattern.search(title) is not None,
            market=self._market_feed,
        )
        return articles[:limit] if limit else articles

    async def fetch_for_query(
        self,
        query: str,
        since: datetime,
        *,
        limit: int | None = None,
    ) -> list[RawArticle]:
        """Headlines containing `query`, from the files the cursor has not yet reached.

        The cursor is not moved: a query is a look, not a collection, and moving
        it would hide those files from the next collection run.
        """
        pattern = headline_pattern({"": [query]})
        if pattern is None:
            return []
        articles = await self._read(
            since, lambda title: pattern.search(title) is not None, advance=False
        )
        return articles[:limit] if limit else articles

    def _slots(self, since: datetime) -> list[datetime]:
        newest = slot_floor(self._clock())
        last = self._cursor.get()
        first = last + SLOT if last is not None else newest - INITIAL_WINDOW + SLOT
        first = max(first, slot_floor(since))
        slots: list[datetime] = []
        slot = first
        while slot <= newest and len(slots) < MAX_FILES_PER_RUN:
            slots.append(slot)
            slot += SLOT
        return slots

    async def _read(
        self,
        since: datetime,
        keep: Callable[[str], bool],
        *,
        advance: bool = True,
        market: bool = False,
    ) -> list[RawArticle]:
        stats = FeedPass()
        articles: list[RawArticle] = []
        now = self._clock().astimezone(UTC)
        cutoff = since.astimezone(UTC)
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=GDELT_TIMEOUT_SECONDS, follow_redirects=True
            ) as client:
                for slot in self._slots(since):
                    stamp = slot.strftime("%Y%m%d%H%M%S")
                    try:
                        response = await client.get(slot_url(slot))
                    except httpx.HTTPError as exc:
                        raise NewsProviderError(
                            self.name, f"{stamp}: request failed: {exc.__class__.__name__}"
                        ) from exc
                    if response.status_code == 404:
                        if now - slot < PUBLISH_GRACE:
                            break  # not published yet; the next run tries it again
                        stats.files_missing += 1
                    elif response.status_code != 200:
                        raise NewsProviderError(self.name, f"{stamp}: HTTP {response.status_code}")
                    else:
                        try:
                            batch = read_gkg(response.content, keep, stats, market=market)
                        except ValueError as exc:
                            raise NewsProviderError(self.name, f"{stamp}: {exc}") from exc
                        stats.files_read += 1
                        articles.extend(
                            a for a in batch if a.published_at is None or a.published_at >= cutoff
                        )
                    stats.slots.append(stamp)
                    if advance:
                        # Moved file by file, so a failure on the next file keeps
                        # this one read - its articles leave on `partial`.
                        self._cursor.set(slot)
        except NewsProviderError as exc:
            exc.partial = articles
            log.warning("news.gdelt.pass_failed", error=str(exc), **_stats(stats))
            raise
        log.info("news.gdelt.pass", **_stats(stats))
        return articles


def _stats(stats: FeedPass) -> dict[str, object]:
    return {
        "files_read": stats.files_read,
        "files_missing": stats.files_missing,
        "rows": stats.rows,
        "untitled": stats.untitled,
        "malformed": stats.malformed,
        "matched": stats.matched,
        "market": stats.market,
        "excluded_outlets": dict(stats.excluded.most_common()),
        "first_slot": stats.slots[0] if stats.slots else None,
        "last_slot": stats.slots[-1] if stats.slots else None,
    }
