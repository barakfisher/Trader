"""Each news outlet's home country, from GDELT's own table (`data/outlets`).

Discovery uses it for one question: is a recurring phrase a theme, or one
country's local news (decision 61)? The broader market feed carries India's IPO
calendar and Australia's rate decisions next to global themes, and for a user
who trades US markets "cash rate" is the Reserve Bank of Australia, not a theme.

The outlet's country, not the article's: GDELT's per-article locations name the
places a story mentions, so an article on Iran and oil is "Iran" wherever it was
published. The question here is whose press is carrying a phrase, and that is
the outlet's.

An outlet the table does not list has no country (None). The table is from
2018, and 98% of the market feed's articles in the measured week came from a
listed outlet.
"""

from __future__ import annotations

import gzip
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from app.news.market_feed import outlet

#: The file inside `outlets_dir`: gzipped `domain \t code \t name` lines.
TABLE_FILE = "countries.tsv.gz"


@dataclass(frozen=True, slots=True)
class Country:
    #: FIPS 10-4, as GDELT writes it: "US", "UK", "AS" (Australia), "IN" (India).
    code: str
    name: str


class OutletCountries:
    """Outlet -> home country, for outlets spelled as `market_feed.outlet` spells them."""

    def __init__(self, by_outlet: dict[str, Country]) -> None:
        self._by_outlet = by_outlet
        self._names = {country.code: country.name for country in by_outlet.values()}

    def __len__(self) -> int:
        return len(self._by_outlet)

    def country(self, source: str) -> Country | None:
        return self._by_outlet.get(outlet(source))

    def name(self, code: str) -> str | None:
        """A country's name by its code: "AS" -> "Australia"."""
        return self._names.get(code)


def parse_table(lines: list[str]) -> OutletCountries:
    """The table from its lines; a malformed line is skipped, not guessed at."""
    names: dict[tuple[str, str], Country] = {}
    by_outlet: dict[str, Country] = {}
    for line in lines:
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 3 or not parts[0] or not parts[1]:
            continue
        # One Country object per code, not per outlet: 189,545 lines, ~250 countries.
        key = (parts[1], parts[2])
        country = names.get(key) or names.setdefault(key, Country(code=parts[1], name=parts[2]))
        by_outlet[outlet(parts[0])] = country
    return OutletCountries(by_outlet)


@lru_cache(maxsize=4)
def load_outlet_countries(outlets_dir: str) -> OutletCountries:
    """The committed table, read once per process.

    A missing file is an error, not an empty table: an empty one would call
    every outlet countryless and every local story a theme, silently.
    """
    path = Path(outlets_dir) / TABLE_FILE
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        table = parse_table(handle.readlines())
    if not len(table):
        raise ValueError(f"{path} lists no outlets")
    return table
