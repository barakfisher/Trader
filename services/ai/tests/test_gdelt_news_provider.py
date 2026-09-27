"""The GDELT raw-file provider, driven through httpx.MockTransport: no test reaches the network.

Each test builds GKG files in memory, shaped on the file checked by hand on
2026-09-27 (27 tab-separated columns, the headline in `<PAGE_TITLE>` inside the
extras column, HTML entities in some titles). What is pinned: only headlines
naming a followed instrument are kept; the cursor decides which files are read
and moves only past files that were read or are really missing; a late file is
retried by the next run; and a failure partway keeps what was read before it.
"""

from __future__ import annotations

import io
import zipfile
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.news.base import NewsProviderError
from app.news.gdelt import (
    INITIAL_WINDOW,
    MAX_FILES_PER_RUN,
    PUBLISH_GRACE,
    SLOT,
    GdeltNewsProvider,
    MemoryFeedCursor,
    headline_pattern,
    slot_floor,
    slot_url,
)

NOW = datetime(2026, 9, 27, 14, 20, tzinfo=UTC)
NEWEST = slot_floor(NOW)  # 14:15
SINCE = NOW - timedelta(hours=48)
NAMES = {"NVDA": ["Nvidia", "NVIDIA"], "AAPL": ["Apple"]}


def _row(title: str | None, *, url: str, slot: datetime, source: str = "example.com") -> str:
    columns = [""] * 27
    columns[0] = f"{slot:%Y%m%d%H%M%S}-{abs(hash(url)) % 1000}"
    columns[1] = f"{slot:%Y%m%d%H%M%S}"
    columns[3] = source
    columns[4] = url
    columns[26] = (
        f"<PAGE_TITLE>{title}</PAGE_TITLE>" if title is not None else "<PAGE_LINKS></PAGE_LINKS>"
    )
    return "\t".join(columns)


def _gkg(slot: datetime, *titles: str | None) -> bytes:
    lines = [
        _row(title, url=f"https://example.com/{slot:%H%M}/{i}", slot=slot)
        for i, title in enumerate(titles)
    ]
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(f"{slot:%Y%m%d%H%M%S}.gkg.csv", "\n".join(lines))
    return buffer.getvalue()


class Feed:
    """A transport serving files by URL; anything not listed is a 404."""

    def __init__(self, files: dict[datetime, bytes | httpx.Response] | None = None) -> None:
        self.files = {slot_url(slot): body for slot, body in (files or {}).items()}
        self.requested: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.requested.append(url)
        body = self.files.get(url)
        if isinstance(body, httpx.Response):
            return body
        if body is None:
            return httpx.Response(404, text="Not Found")
        return httpx.Response(200, content=body)


def _provider(feed: Feed, cursor: MemoryFeedCursor, now: datetime = NOW) -> GdeltNewsProvider:
    return GdeltNewsProvider(cursor=cursor, transport=httpx.MockTransport(feed), clock=lambda: now)


async def _fetch(provider: GdeltNewsProvider) -> list:
    return await provider.fetch_for_symbols(["NVDA", "AAPL"], SINCE, names=NAMES)


# --- what is kept -------------------------------------------------------------


async def test_keeps_only_headlines_that_name_a_followed_instrument() -> None:
    feed = Feed(
        {
            NEWEST: _gkg(
                NEWEST,
                "Nvidia lifts its data-centre forecast",
                "Breakfast ideas from a dietitian",
                "Why Apple's services keep growing",
                "Pineapple prices spike",  # "Apple" inside a word is not a mention
            )
        }
    )
    articles = await _fetch(_provider(feed, MemoryFeedCursor(NEWEST - SLOT)))
    assert [a.title for a in articles] == [
        "Nvidia lifts its data-centre forecast",
        "Why Apple's services keep growing",
    ]
    article = articles[0]
    assert article.body == article.title  # headlines only
    assert article.source == "example.com"
    assert article.published_at == NEWEST


async def test_headlines_are_unescaped_and_untitled_rows_skipped() -> None:
    feed = Feed({NEWEST: _gkg(NEWEST, "Apple&#x27;s   chip &amp; cloud plans", None, "")})
    articles = await _fetch(_provider(feed, MemoryFeedCursor(NEWEST - SLOT)))
    assert [a.title for a in articles] == ["Apple's chip & cloud plans"]


async def test_no_names_is_an_answer_and_reads_nothing() -> None:
    feed = Feed({NEWEST: _gkg(NEWEST, "Nvidia news")})
    provider = _provider(feed, MemoryFeedCursor(NEWEST - SLOT))
    assert await provider.fetch_for_symbols(["NVDA"], SINCE, names={}) == []
    assert feed.requested == []


def test_the_pattern_matches_whole_words_ignoring_case() -> None:
    pattern = headline_pattern({"V": ["Valero Energy", "Valero"]})
    assert pattern is not None
    assert pattern.search("VALERO cuts runs")
    assert pattern.search("Valero Energy beats")
    assert not pattern.search("Valeroso wins")


# --- which files are read -----------------------------------------------------


async def test_reads_from_just_after_the_cursor_up_to_the_newest_slot() -> None:
    cursor = MemoryFeedCursor(NEWEST - 3 * SLOT)
    feed = Feed(
        {
            NEWEST - 2 * SLOT: _gkg(NEWEST - 2 * SLOT),
            NEWEST - SLOT: _gkg(NEWEST - SLOT),
            NEWEST: _gkg(NEWEST),
        }
    )
    await _fetch(_provider(feed, cursor))
    assert feed.requested == [
        slot_url(NEWEST - 2 * SLOT),
        slot_url(NEWEST - SLOT),
        slot_url(NEWEST),
    ]
    assert cursor.last_file_at == NEWEST


async def test_with_no_cursor_reads_only_the_initial_window() -> None:
    cursor = MemoryFeedCursor()
    feed = Feed()
    slots = int(INITIAL_WINDOW / SLOT)
    old = NEWEST - INITIAL_WINDOW + SLOT
    feed.files = {slot_url(old + i * SLOT): _gkg(old + i * SLOT) for i in range(slots)}
    await _fetch(_provider(feed, cursor))
    assert len(feed.requested) == slots
    assert feed.requested[0] == slot_url(old)
    assert cursor.last_file_at == NEWEST


async def test_reads_at_most_the_per_run_cap_oldest_first() -> None:
    start = NEWEST - 40 * SLOT
    cursor = MemoryFeedCursor(start)
    feed = Feed({start + i * SLOT: _gkg(start + i * SLOT) for i in range(1, 41)})
    await _fetch(_provider(feed, cursor))
    assert len(feed.requested) == MAX_FILES_PER_RUN
    assert cursor.last_file_at == start + MAX_FILES_PER_RUN * SLOT


async def test_never_reads_before_since_however_old_the_cursor() -> None:
    cursor = MemoryFeedCursor(NEWEST - timedelta(days=30))
    feed = Feed()
    await GdeltNewsProvider(
        cursor=cursor, transport=httpx.MockTransport(feed), clock=lambda: NOW
    ).fetch_for_symbols(["NVDA"], NOW - timedelta(hours=1), names=NAMES)
    assert feed.requested[0] == slot_url(slot_floor(NOW - timedelta(hours=1)))


async def test_a_late_file_stops_the_run_and_is_tried_again_next_time() -> None:
    cursor = MemoryFeedCursor(NEWEST - 2 * SLOT)
    feed = Feed({NEWEST - SLOT: _gkg(NEWEST - SLOT, "Nvidia one")})  # NEWEST not published yet
    articles = await _fetch(_provider(feed, cursor))
    assert [a.title for a in articles] == ["Nvidia one"]
    assert cursor.last_file_at == NEWEST - SLOT  # not past the late file

    feed.files[slot_url(NEWEST)] = _gkg(NEWEST, "Nvidia two")
    later = await _fetch(_provider(feed, cursor, now=NOW + timedelta(minutes=5)))
    assert [a.title for a in later] == ["Nvidia two"]
    assert cursor.last_file_at == NEWEST


async def test_a_file_missing_past_the_grace_is_passed_over() -> None:
    gone = NEWEST - PUBLISH_GRACE - SLOT
    cursor = MemoryFeedCursor(gone - SLOT)
    feed = Feed({gone + SLOT: _gkg(gone + SLOT, "Apple after the gap")})
    articles = await _fetch(
        _provider(feed, cursor, now=gone + PUBLISH_GRACE + SLOT + timedelta(minutes=1))
    )
    assert [a.title for a in articles] == ["Apple after the gap"]
    assert cursor.last_file_at is not None and cursor.last_file_at >= gone + SLOT


async def test_a_query_looks_without_moving_the_cursor() -> None:
    cursor = MemoryFeedCursor(NEWEST - SLOT)
    feed = Feed({NEWEST: _gkg(NEWEST, "Uranium squeeze deepens", "Nvidia news")})
    articles = await _provider(feed, cursor).fetch_for_query("uranium", SINCE)
    assert [a.title for a in articles] == ["Uranium squeeze deepens"]
    assert cursor.last_file_at == NEWEST - SLOT


# --- failures -----------------------------------------------------------------


@pytest.mark.parametrize(
    "failure",
    [httpx.Response(503, text="busy"), httpx.Response(200, content=b"not a zip")],
    ids=["server-error", "not-a-zip"],
)
async def test_a_failure_keeps_what_was_read_and_the_cursor_where_it_got(
    failure: httpx.Response,
) -> None:
    cursor = MemoryFeedCursor(NEWEST - 2 * SLOT)
    feed = Feed({NEWEST - SLOT: _gkg(NEWEST - SLOT, "Nvidia before the failure"), NEWEST: failure})
    with pytest.raises(NewsProviderError) as raised:
        await _fetch(_provider(feed, cursor))
    assert [a.title for a in raised.value.partial] == ["Nvidia before the failure"]
    assert cursor.last_file_at == NEWEST - SLOT


async def test_a_network_error_is_a_provider_failure() -> None:
    def broken(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    provider = GdeltNewsProvider(
        cursor=MemoryFeedCursor(NEWEST - SLOT),
        transport=httpx.MockTransport(broken),
        clock=lambda: NOW,
    )
    with pytest.raises(NewsProviderError, match="request failed"):
        await _fetch(provider)
