"""SEC EDGAR as a filings provider: full-text search for the market, submissions for a company.

**Which feeds** (measured 2026-11-19, D404):

  * `efts.sec.gov/LATEST/search-index` - EDGAR's full-text search, asked by
    form and date range with no query text. One page holds 100 filings; a
    month of S-1s (amendments included) was 146. `forms=S-1` matches S-1/A too.
  * `data.sec.gov/submissions/CIK##########.json` - one registrant's name,
    industry code, tickers and its latest 1,000 filings.
  * Not the daily form index under `www.sec.gov/Archives`: it refused every
    request without a contact address in the User-Agent ("Undeclared Automated
    Tool", HTTP 403), and this service never sends one.

**The User-Agent** is `edgar_user_agent`, a generic name by default. SEC asks
automated clients to identify themselves; the two hosts above accepted the
default on 2026-11-19. A refusal (403) is reported as such, so an operator
knows to change the setting rather than look for an outage. The user's name or
address never goes in it.

**At most `REQUESTS_PER_SECOND`**, under SEC's fair-access limit of ten:
requests are sequential and spaced. A run makes a dozen searches and at most
`MAX_COMPANIES_PER_RUN` (`upcoming.py`) company requests.

**No retry here.** Full-text search answered HTTP 500 twice in about 25
requests that day; a failed search fails the run, and the orchestrator asks
again within the hour (`RETRY_FAILED_KINDS`), which writes only what the
failed run did not.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Mapping, Sequence
from datetime import date
from typing import Any

import httpx

from app.core.logging import get_logger
from app.filings.base import CompanyFilings, Filing, FilingHit, FilingsProviderError

log = get_logger("filings.edgar")

SEARCH_URL = "https://efts.sec.gov/LATEST/search-index"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{folder}/{document}"

#: SEC's fair-access limit is 10 a second; stay under it.
REQUESTS_PER_SECOND = 8
#: Full-text search answers 100 filings a page.
SEARCH_PAGE_SIZE = 100
#: Pages one search may read: 1,000 filings, about seven months of S-1s.
MAX_SEARCH_PAGES = 10
TIMEOUT_SECONDS = 30.0


def cik10(value: str | int) -> str:
    """A Central Index Key as SEC's file names write it: ten digits, zero-padded."""
    return f"{int(value):010d}"


def filing_url(cik: str, accession: str, document: str) -> str:
    return ARCHIVES_URL.format(
        cik=int(cik), folder=accession.replace("-", ""), document=document
    ).rstrip("/")


class EdgarFilingsProvider:
    name = "edgar"

    def __init__(
        self,
        *,
        user_agent: str,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Any] = asyncio.sleep,
    ) -> None:
        self._headers = {"User-Agent": user_agent, "Accept-Encoding": "gzip, deflate"}
        self._transport = transport
        self._clock = clock
        self._sleep = sleep
        self._next_request_at = 0.0

    async def search(self, forms: Sequence[str], start: date, end: date) -> list[FilingHit]:
        hits: list[FilingHit] = []
        params = {
            "forms": ",".join(forms),
            "dateRange": "custom",
            "startdt": start.isoformat(),
            "enddt": end.isoformat(),
        }
        for page in range(MAX_SEARCH_PAGES):
            body = await self._get_json(SEARCH_URL, {**params, "from": page * SEARCH_PAGE_SIZE})
            try:
                block = body["hits"]
                rows = block["hits"]
                total = int(block["total"]["value"])
            except (KeyError, TypeError, ValueError) as exc:
                raise FilingsProviderError(self.name, "search: unreadable answer") from exc
            hits.extend(hit for hit in (_to_hit(row) for row in rows) if hit is not None)
            if not rows or (page + 1) * SEARCH_PAGE_SIZE >= total:
                break
        else:
            log.warning("filings.edgar.search_truncated", forms=params["forms"], kept=len(hits))
        return hits

    async def company(self, cik: str) -> CompanyFilings:
        body = await self._get_json(SUBMISSIONS_URL.format(cik=cik10(cik)), None)
        try:
            return parse_submissions(body)
        except (KeyError, TypeError, ValueError) as exc:
            raise FilingsProviderError(self.name, f"{cik}: unreadable submissions") from exc

    async def _get_json(self, url: str, params: Mapping[str, Any] | None) -> Any:
        wait = self._next_request_at - self._clock()
        if wait > 0:
            await self._sleep(wait)
        self._next_request_at = max(self._clock(), self._next_request_at) + 1 / REQUESTS_PER_SECOND
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=TIMEOUT_SECONDS, headers=self._headers
            ) as client:
                response = await client.get(url, params=params)
        except httpx.HTTPError as exc:
            raise FilingsProviderError(
                self.name, f"request failed: {exc.__class__.__name__}"
            ) from exc
        if response.status_code == 403:
            raise FilingsProviderError(
                self.name, "HTTP 403: SEC refused the request; check EDGAR_USER_AGENT"
            )
        if response.status_code != 200:
            raise FilingsProviderError(self.name, f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise FilingsProviderError(self.name, "the answer is not JSON") from exc


def _to_hit(row: Mapping[str, Any]) -> FilingHit | None:
    """A search row; None for one without a registrant, form or date."""
    source = row.get("_source") or {}
    ciks = source.get("ciks") or []
    accession = source.get("adsh") or str(row.get("_id", "")).partition(":")[0]
    form = source.get("form")
    filed = source.get("file_date")
    if not ciks or not accession or not form or not filed:
        return None
    try:
        # The first CIK is the registrant; any others are co-registrants.
        return FilingHit(
            cik=cik10(ciks[0]), accession=accession, form=form, filed_on=date.fromisoformat(filed)
        )
    except ValueError:
        return None


def parse_submissions(body: Mapping[str, Any]) -> CompanyFilings:
    cik = cik10(body["cik"])
    recent = body["filings"]["recent"]
    filings = tuple(
        Filing(
            accession=accession,
            form=form,
            filed_on=date.fromisoformat(filed),
            url=filing_url(cik, accession, document or ""),
        )
        for accession, form, filed, document in zip(
            recent["accessionNumber"],
            recent["form"],
            recent["filingDate"],
            recent["primaryDocument"],
            strict=True,
        )
    )
    tickers = tuple(str(t) for t in body.get("tickers") or [])
    exchanges = tuple((str(e) if e else None) for e in body.get("exchanges") or [])
    return CompanyFilings(
        cik=cik,
        name=str(body.get("name") or "").strip(),
        sic=str(body.get("sic") or ""),
        tickers=tickers,
        exchanges=exchanges,
        filings=filings,
        has_older_filings=bool(body["filings"].get("files")),
    )
