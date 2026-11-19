"""The EDGAR client, against a scripted transport: no network.

Pinned: the configured User-Agent goes with every request; a search reads
every page and stops at the total; requests are spaced to SEC's limit; a 403
names the User-Agent setting; any other failure is a `FilingsProviderError`;
a submissions document becomes a company with URLs a person can open.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.config import Settings
from app.filings.base import FilingsProviderError
from app.filings.edgar import (
    REQUESTS_PER_SECOND,
    SEARCH_PAGE_SIZE,
    EdgarFilingsProvider,
    cik10,
    filing_url,
)
from app.filings.fixture import FIXTURE_FILENAME, FixtureFilingsProvider
from app.filings.registry import build_filings_provider

FIXTURES = Path(__file__).resolve().parents[3] / "data" / "fixtures"
ANTHROPIC = "0002130357"
USER_AGENT = "TestAgent/1.0 tests"


def _row(n: int) -> dict[str, Any]:
    return {
        "_id": f"0000000001-26-{n:06d}:doc.htm",
        "_source": {
            "ciks": [f"{n:010d}"],
            "adsh": f"0000000001-26-{n:06d}",
            "form": "S-1",
            "file_date": "2026-11-18",
        },
    }


class Clock:
    """A clock that only moves when the provider sleeps."""

    def __init__(self) -> None:
        self.now = 100.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def provider(handler: Any, clock: Clock | None = None) -> EdgarFilingsProvider:
    clock = clock or Clock()
    return EdgarFilingsProvider(
        user_agent=USER_AGENT,
        transport=httpx.MockTransport(handler),
        clock=clock,
        sleep=clock.sleep,
    )


async def test_a_search_reads_every_page_and_sends_the_user_agent() -> None:
    total = SEARCH_PAGE_SIZE + 3
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        start = int(request.url.params["from"])
        rows = [_row(n) for n in range(start, min(start + SEARCH_PAGE_SIZE, total))]
        return httpx.Response(200, json={"hits": {"total": {"value": total}, "hits": rows}})

    hits = await provider(handler).search(("S-1", "F-1"), date(2026, 10, 20), date(2026, 11, 19))
    assert len(hits) == total
    assert len(seen) == 2
    assert {r.headers["user-agent"] for r in seen} == {USER_AGENT}
    assert seen[0].url.params["forms"] == "S-1,F-1"
    assert seen[0].url.params["startdt"] == "2026-10-20"
    assert seen[0].url.params["enddt"] == "2026-11-19"
    assert hits[0].cik == cik10(0) and hits[0].form == "S-1"
    assert hits[0].filed_on == date(2026, 11, 18)


async def test_requests_are_spaced_to_the_rate_limit() -> None:
    clock = Clock()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"hits": {"total": {"value": 0}, "hits": []}})

    edgar = provider(handler, clock)
    for _ in range(3):
        await edgar.search(("S-1",), date(2026, 11, 1), date(2026, 11, 2))
    assert clock.sleeps == pytest.approx([1 / REQUESTS_PER_SECOND] * 2)


async def test_a_refusal_names_the_user_agent_setting() -> None:
    edgar = provider(lambda request: httpx.Response(403, text="Undeclared Automated Tool"))
    with pytest.raises(FilingsProviderError, match="EDGAR_USER_AGENT"):
        await edgar.search(("S-1",), date(2026, 11, 1), date(2026, 11, 2))


@pytest.mark.parametrize(
    "response",
    [httpx.Response(500), httpx.Response(200, text="<html>"), httpx.Response(200, json={})],
)
async def test_a_failed_or_unreadable_search_raises(response: httpx.Response) -> None:
    with pytest.raises(FilingsProviderError):
        await provider(lambda request: response).search(
            ("S-1",), date(2026, 11, 1), date(2026, 11, 2)
        )


async def test_a_dropped_connection_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    with pytest.raises(FilingsProviderError, match="ConnectError"):
        await provider(handler).company(ANTHROPIC)


async def test_a_company_is_its_submissions_document() -> None:
    body = json.loads((FIXTURES / FIXTURE_FILENAME).read_text())["companies"][ANTHROPIC]

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == f"/submissions/CIK{ANTHROPIC}.json"
        return httpx.Response(200, json=body)

    company = await provider(handler).company("2130357")
    assert company.cik == ANTHROPIC
    assert company.name == "Anthropic, PBC"
    assert company.tickers == ("ANT",)
    assert company.exchanges == (None,)
    assert not company.has_older_filings
    s1 = next(f for f in company.filings if f.form == "S-1")
    assert s1.filed_on == date(2026, 10, 26)
    assert s1.url == filing_url(ANTHROPIC, "0001628280-26-067168", "anthropicpbc-sx1.htm")
    assert s1.url.startswith("https://www.sec.gov/Archives/edgar/data/2130357/000162828026067168/")


async def test_the_fixture_matches_amendments_as_edgar_does() -> None:
    fixture = FixtureFilingsProvider(FIXTURES)
    hits = await fixture.search(("S-1",), date(2026, 10, 20), date(2026, 11, 19))
    forms = {hit.form for hit in hits if hit.cik == ANTHROPIC}
    assert forms == {"S-1", "S-1/A"}
    assert await fixture.search(("S-1",), date(2025, 1, 1), date(2025, 1, 2)) == []
    with pytest.raises(FilingsProviderError):
        await fixture.company("0000000042")


def test_the_setting_picks_the_provider() -> None:
    def settings(value: str) -> Settings:
        return Settings(_env_file=None, filings_provider=value)  # type: ignore[call-arg]

    assert isinstance(build_filings_provider(settings("edgar")), EdgarFilingsProvider)
    assert isinstance(build_filings_provider(settings("fixture")), FixtureFilingsProvider)
    assert build_filings_provider(settings("off")) is None


def test_the_default_user_agent_names_no_person() -> None:
    agent = Settings(_env_file=None).edgar_user_agent  # type: ignore[call-arg]
    assert "@" not in agent
    assert agent
