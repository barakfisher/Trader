"""The filings provider contract (guideline 6): who filed what with a regulator, and when.

The third such contract, beside market data (`app/providers/base.py`) and news
(`app/news/base.py`), and the same shape: a provider names itself, returns what
it can, and raises `FilingsProviderError` to mean "unusable right now".

Two questions, because the upcoming-IPO run (`app/filings/upcoming.py`) asks
two:

  * `search` - which filings of these forms were made in a date window. One
    request answers a page of the whole market, so the run learns of a new
    registrant without knowing its name.
  * `company` - one registrant's whole recent history: its name, industry code,
    tickers, and every filing with its form and date. A search hit says only
    that a filing exists; whether the registrant is a fresh company or one that
    has reported for years is in its history.

**Dates and forms only.** Nothing here reads a filing's text: a price range or a
share count sits in prospectus prose, and a figure taken from prose by a parser
or a model is the unsourced number guideline 7 bars.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Protocol, runtime_checkable


class FilingsProviderError(RuntimeError):
    """The provider could not answer: the request failed, or the answer was unreadable."""

    def __init__(self, provider: str, message: str, *, refused: bool = False) -> None:
        super().__init__(f"{provider}: {message}")
        self.provider = provider
        #: The source refused this client (HTTP 403), not one request: retrying
        #: other requests the same way will not help.
        self.refused = refused


@dataclass(frozen=True, slots=True)
class FilingHit:
    """One filing a search found: whose, which form, filed when."""

    #: The registrant's ten-digit Central Index Key, zero-padded.
    cik: str
    #: `0001628280-26-067168`: the filing's own key, unique across EDGAR.
    accession: str
    #: The form as filed, amendments included (`S-1/A`).
    form: str
    filed_on: date


@dataclass(frozen=True, slots=True)
class Filing:
    accession: str
    form: str
    filed_on: date
    #: Where a person reads it. Never fetched by this service.
    url: str


@dataclass(frozen=True, slots=True)
class CompanyFilings:
    """One registrant as the regulator lists it, with its recent filings."""

    cik: str
    name: str
    #: Standard Industrial Classification code; empty for most funds and trusts.
    sic: str
    tickers: tuple[str, ...]
    #: One per ticker; None where the regulator does not say.
    exchanges: tuple[str | None, ...]
    filings: tuple[Filing, ...] = field(default=())
    #: The history goes back past what was returned - a long-reporting company.
    has_older_filings: bool = False


@runtime_checkable
class FilingsProvider(Protocol):
    name: str

    async def search(self, forms: Sequence[str], start: date, end: date) -> list[FilingHit]:
        """Every filing of `forms` (amendments included) made from `start` to `end`, inclusive."""
        ...

    async def company(self, cik: str) -> CompanyFilings:
        """One registrant's recent history."""
        ...
