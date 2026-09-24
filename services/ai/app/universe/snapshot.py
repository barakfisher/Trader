"""Which instruments a topic can resolve to, decided by rule rather than by hand.

A topic resolver can only offer what is in its universe, so the universe decides
what the topic eval measures. If it were assembled from the eval's own answers,
every case would be choosing among correct answers and the eval would pass
while measuring nothing - the same failure `data/eval/ask.json` guards against
by holding its cases out of the thresholds. So membership is a screen over the
whole listed market, and no rule in this file names a symbol.

The screen (see `SCREEN`):

- **Equities** listed on a primary US exchange with a market cap of at least
  `MIN_EQUITY_SIZE_MINOR`. `region=us` alone admits thousands of OTC listings of
  foreign ordinaries, which are the same companies as their ADRs under a second
  name.
- **ETFs** on the same exchanges with **fund net assets** of at least
  `MIN_ETF_SIZE_MINOR`. An ETF has no market cap, so a market-cap screen alone
  would silently drop every fund. The ETF floor is ten times lower than the
  equity floor because thematic funds are small - the online-retail and cloud
  ETFs are well under $1B - and M5 slice 2 reads what they hold as evidence of
  which companies belong to a theme (`ETF_HOLDINGS_FILE`).

Then two reductions, both about companies rather than symbols:

- **Preferred shares are dropped.** `JPM-PC` is a fixed-income claim on
  JPMorgan, not a way into its business, and it carries its issuer's description
  word for word, so it would crowd the resolver's candidates with duplicates.
- **One listing per company**, the most traded one: GOOG and GOOGL, BRK-A and
  BRK-B describe one business. Volume decides because the listing people trade
  is the one they would hold.

**Descriptions are not committed; membership is.** A business summary is
Yahoo's text, licensed from its data vendors, and the concept corpus admits
only licence-clean text (`kb_documents.license` is NOT NULL for that reason).
Which instruments are in the universe, and facts about them - name, exchange,
sector, size - are data rather than prose, and committing them is what keeps
the eval reproducible. The descriptions live in a gitignored file and in the
database, fetched per installation.

Market cap and net assets are recorded with the snapshot's `as_of` and are
**not** embedded. They move every trading day; a description moves when the
business does. Filtering by size is a SQL predicate beside the vector search,
not a property of a vector.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

#: Primary US venues, as Yahoo codes them: Nasdaq Global Select / Global /
#: Capital, NYSE, NYSE American, Cboe BZX, NYSE Arca.
PRIMARY_US_EXCHANGES = ("NMS", "NGM", "NCM", "NYQ", "ASE", "BTS", "PCX")

#: One billion US dollars, in cents: the equity floor.
MIN_EQUITY_SIZE_MINOR = 1_000_000_000 * 100

#: One hundred million US dollars, in cents: the ETF floor. See the docstring.
MIN_ETF_SIZE_MINOR = 100_000_000 * 100

SCREEN: dict[str, object] = {
    "region": "us",
    "exchanges": list(PRIMARY_US_EXCHANGES),
    "equity": "intradaymarketcap >= min_equity_size",
    "etf": "fundnetassets >= min_etf_size",
    "min_equity_size_minor": MIN_EQUITY_SIZE_MINOR,
    "min_etf_size_minor": MIN_ETF_SIZE_MINOR,
    "min_size_currency": "USD",
}

#: `JPM-PC`, `BAC-PB`, `PSA-PK`: Yahoo's spelling of a preferred series.
_PREFERRED = re.compile(r"-P[A-Z]?$")


@dataclass(frozen=True, slots=True)
class UniverseInstrument:
    symbol: str
    name: str | None
    asset_class: str  # 'equity' | 'etf'
    exchange: str
    currency: str | None
    #: Equity market cap in minor units of `currency`. Null when Yahoo did not
    #: report one - never zero, which would read as a company worth nothing.
    market_cap_minor: int | None
    #: ETF net assets in minor units of `currency`. Null for an equity.
    net_assets_minor: int | None
    sector: str | None
    industry: str | None
    #: For an ETF, Yahoo's fund category ("Natural Resources"); null otherwise.
    category: str | None
    #: The business summary a topic is matched against. Null when Yahoo has
    #: none, and such an instrument can then never be a candidate - which is
    #: reported by the build rather than papered over with the name.
    description: str | None

    def membership_json(self) -> dict[str, Any]:
        """Everything but the description: the part that is committed."""
        row = asdict(self)
        del row["description"]
        return row


def is_preferred(symbol: str) -> bool:
    return bool(_PREFERRED.search(symbol))


def _to_minor(value: object) -> int | None:
    """Whole currency units from Yahoo (int or float) to integer minor units."""
    if value is None or isinstance(value, bool):
        return None
    amount = Decimal(str(value))
    if amount <= 0:
        return None
    return int((amount * 100).to_integral_value())


def select(quotes: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Screener rows reduced to one tradeable listing per company, by symbol.

    Rows with no name are kept individually: grouping every unnamed row
    together would discard all but one of them, which is a silent loss of
    exactly the rows least able to explain themselves.
    """
    best: dict[str, Mapping[str, Any]] = {}
    for quote in quotes:
        symbol = str(quote["symbol"])
        if is_preferred(symbol):
            continue
        key = str(quote.get("longName") or f"\x00{symbol}")
        current = best.get(key)
        if current is None or _volume(quote) > _volume(current):
            best[key] = quote
    return sorted(best.values(), key=lambda q: str(q["symbol"]))


def _volume(quote: Mapping[str, Any]) -> int:
    return int(quote.get("averageDailyVolume3Month") or 0)


def to_instrument(quote: Mapping[str, Any], info: Mapping[str, Any]) -> UniverseInstrument:
    """One universe row from a screener row and the ticker's `info` payload."""
    is_etf = str(quote.get("quoteType")) == "ETF"
    return UniverseInstrument(
        symbol=str(quote["symbol"]),
        name=quote.get("longName") or quote.get("shortName"),
        asset_class="etf" if is_etf else "equity",
        exchange=str(quote["exchange"]),
        currency=quote.get("currency"),
        market_cap_minor=None if is_etf else _to_minor(quote.get("marketCap")),
        net_assets_minor=_to_minor(quote.get("netAssets")) if is_etf else None,
        sector=info.get("sector"),
        industry=info.get("industry"),
        category=info.get("category") if is_etf else None,
        description=(info.get("longBusinessSummary") or "").strip() or None,
    )


MEMBERSHIP_FILE = "instruments.jsonl"
MANIFEST_FILE = "manifest.json"
#: Gitignored: Yahoo's prose, fetched per installation.
DESCRIPTIONS_FILE = "descriptions.local.jsonl"
#: Committed: which instruments each ETF holds and at what weight. Facts about a
#: fund's composition, like the membership file, not prose.
ETF_HOLDINGS_FILE = "etf_holdings.jsonl"


@dataclass(frozen=True, slots=True)
class EtfHolding:
    """One of an ETF's top holdings as Yahoo reports it, before any matching.

    `symbol` is kept exactly as written because it is often not a US ticker -
    Cameco appears as `CCO.TO`, TSMC as `2330.TW` - and `name` is kept because it
    is what matches such a holding to its US listing (`profiles.load_holdings`).
    Yahoo exposes only each fund's ten largest positions.
    """

    etf: str
    position: int
    symbol: str
    name: str | None
    #: Fraction of the fund, as a decimal string ("0.2260"); never a float on
    #: the wire (guideline 4).
    weight: str


def read_holdings(directory: Path) -> list[EtfHolding]:
    path = directory / ETF_HOLDINGS_FILE
    return [EtfHolding(**row) for row in _read_jsonl(path)] if path.exists() else []


@dataclass(frozen=True, slots=True)
class Snapshot:
    as_of: str
    instruments: list[UniverseInstrument]


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def load_snapshot(directory: Path) -> Snapshot:
    """The committed membership, joined to whatever descriptions this machine has.

    A member with no local description comes back with `description=None`
    rather than being dropped, so the caller can report how much of the
    universe it cannot match against - a count that silently shrank would look
    exactly like a universe that had.
    """
    manifest = json.loads((directory / MANIFEST_FILE).read_text(encoding="utf-8"))
    descriptions_path = directory / DESCRIPTIONS_FILE
    descriptions = (
        {row["symbol"]: row["description"] for row in _read_jsonl(descriptions_path)}
        if descriptions_path.exists()
        else {}
    )
    instruments = [
        UniverseInstrument(**row, description=descriptions.get(row["symbol"]))
        for row in _read_jsonl(directory / MEMBERSHIP_FILE)
    ]
    return Snapshot(as_of=str(manifest["as_of"]), instruments=instruments)
