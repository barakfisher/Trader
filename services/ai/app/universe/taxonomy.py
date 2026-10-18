"""The universe's taxonomy: sectors, industries and ETF categories, with counts (D155).

Rewritten from `instrument_profiles` inside every universe load, in the load's
own transaction. The agent creator's "Sectors & industries" picker reads only
`universe_taxonomy`, so it offers exactly what the screened universe holds.

**ETFs have no sector.** Yahoo gives a fund a category instead ("Technology",
"Large Blend", "Muni National Long"). A sector filter that ignored ETFs would
let a "Technology only" agent buy nothing but single stocks, so the categories
that are about one sector are mapped onto Yahoo's equity sectors here, once,
in reviewed code. Every other category stays a category of its own with no
sector: forcing "Large Blend" into a sector would be inventing a fact
(guideline 7).

**A category the map has never seen** - a rescreen can bring one - is stored
with no sector and reported, never guessed. The contract test holds the map to
the committed snapshot, so a category reaches production unmapped only through
a rescreen, and the load's report names it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.core.logging import get_logger

log = get_logger("universe.taxonomy")

#: Yahoo's equity sectors, as the screener spells them.
SECTORS = frozenset(
    {
        "Basic Materials",
        "Communication Services",
        "Consumer Cyclical",
        "Consumer Defensive",
        "Energy",
        "Financial Services",
        "Healthcare",
        "Industrials",
        "Real Estate",
        "Technology",
        "Utilities",
    }
)

#: ETF categories that hold one sector, and the equity sector they hold.
ETF_CATEGORY_SECTORS: dict[str, str] = {
    "Communications": "Communication Services",
    "Consumer Cyclical": "Consumer Cyclical",
    "Consumer Defensive": "Consumer Defensive",
    "Energy Limited Partnership": "Energy",
    "Equity Energy": "Energy",
    "Equity Precious Metals": "Basic Materials",
    "Financial": "Financial Services",
    "Global Real Estate": "Real Estate",
    "Health": "Healthcare",
    "Industrials": "Industrials",
    "Natural Resources": "Basic Materials",
    "Real Estate": "Real Estate",
    "Technology": "Technology",
    "Utilities": "Utilities",
}

#: ETF categories that are not about one sector: broad equity, regions, bonds,
#: allocation, commodities, digital assets, strategies and leveraged trading.
#: Listed rather than implied, so that a category nobody has looked at is
#: distinguishable from one that was looked at and left without a sector.
#: "Infrastructure" is here on purpose: its funds split between Utilities,
#: Industrials and Energy, and naming one of them would be wrong for the rest.
#: "Miscellaneous Sector" too: each of its funds holds a different sector.
NO_SECTOR_CATEGORIES = frozenset(
    {
        "Aggressive Allocation",
        "Bank Loan",
        "Commodities Broad Basket",
        "Commodities Focused",
        "Convertibles",
        "Corporate Bond",
        "Defined Outcome",
        "Derivative Income",
        "Digital Assets",
        "Diversified Emerging Mkts",
        "Emerging Markets Bond",
        "Emerging-Markets Local-Currency Bond",
        "Equity Digital Assets",
        "Equity Hedged",
        "Equity Market Neutral",
        "Europe Stock",
        "Event Driven",
        "Focused Region",
        "Foreign Large Blend",
        "Foreign Large Growth",
        "Foreign Large Value",
        "Foreign Small/Mid Blend",
        "Foreign Small/Mid Value",
        "Global Bond",
        "Global Bond-USD Hedged",
        "Global Conservative Allocation",
        "Global Large-Stock Blend",
        "Global Large-Stock Growth",
        "Global Large-Stock Value",
        "Global Moderate Allocation",
        "Global Moderately Aggressive Allocation",
        "Global Moderately Conservative Allocation",
        "Global Small/Mid Stock",
        "Government Mortgage-Backed Bond",
        "Greater China Region",
        "High Yield Bond",
        "High Yield Muni",
        "India Equity",
        "Inflation-Protected Bond",
        "Infrastructure",
        "Intermediate Core Bond",
        "Intermediate Core-Plus Bond",
        "Intermediate Government",
        "Japan Stock",
        "Large Blend",
        "Large Growth",
        "Large Value",
        "Long Government",
        "Long-Short Equity",
        "Long-Term Bond",
        "Macro Trading",
        "Mid-Cap Blend",
        "Mid-Cap Growth",
        "Mid-Cap Value",
        "Miscellaneous Allocation",
        "Miscellaneous Sector",
        "Moderate Allocation",
        "Moderately Conservative Allocation",
        "Money Market-Taxable",
        "Multi-Asset Overlay",
        "Multisector Bond",
        "Multistrategy",
        "Muni California Intermediate",
        "Muni California Long",
        "Muni Massachusetts",
        "Muni Minnesota",
        "Muni National Interm",
        "Muni National Long",
        "Muni National Short",
        "Muni New Jersey",
        "Muni New York Intermediate",
        "Muni New York Long",
        "Muni Single State Short",
        "Muni Target Maturity",
        "Nontraditional Bond",
        "Pacific/Asia ex-Japan Stk",
        "Preferred Stock",
        "Prime Money Market",
        "Relative Value Arbitrage",
        "Securitized Bond - Diversified",
        "Securitized Bond - Focused",
        "Short Government",
        "Short-Term Bond",
        "Short-Term Inflation-Protected Bond",
        "Single Currency",
        "Small Blend",
        "Small Growth",
        "Small Value",
        "Systematic Trend",
        "Tactical Allocation",
        "Target Maturity",
        "Target-Date 2035",
        "Target-Date 2040",
        "Trading--Inverse Commodities",
        "Trading--Inverse Debt",
        "Trading--Inverse Equity",
        "Trading--Leveraged Commodities",
        "Trading--Leveraged Debt",
        "Trading--Leveraged Equity",
        "Trading--Miscellaneous",
        "Ultrashort Bond",
    }
)


@dataclass(frozen=True, slots=True)
class TaxonomyRow:
    kind: str
    name: str
    sector: str | None
    instruments: int


@dataclass(frozen=True, slots=True)
class TaxonomyReport:
    rows: int
    written: int
    removed: int
    #: ETF categories neither mapped nor listed as having no sector.
    unmapped: list[str] = field(default_factory=list)


def category_sector(category: str) -> str | None:
    return ETF_CATEGORY_SECTORS.get(category)


def derive_rows(connection: Connection) -> tuple[list[TaxonomyRow], list[str]]:
    """The rows the screened profiles imply, and the categories nobody has classified."""
    industries = connection.execute(
        text(
            "SELECT industry, sector, count(*)::int AS n FROM instrument_profiles "
            "WHERE membership = 'screened' AND industry IS NOT NULL AND sector IS NOT NULL "
            "GROUP BY industry, sector"
        )
    ).all()
    categories = connection.execute(
        text(
            "SELECT category, count(*)::int AS n FROM instrument_profiles "
            "WHERE membership = 'screened' AND category IS NOT NULL GROUP BY category"
        )
    ).all()
    rows = [TaxonomyRow("industry", r.industry, r.sector, r.n) for r in industries]
    rows += [
        TaxonomyRow("etf_category", r.category, category_sector(r.category), r.n)
        for r in categories
    ]
    unmapped = sorted(
        r.category
        for r in categories
        if r.category not in ETF_CATEGORY_SECTORS and r.category not in NO_SECTOR_CATEGORIES
    )
    return sorted(rows, key=lambda row: (row.kind, row.name)), unmapped


def rebuild_taxonomy(connection: Connection) -> TaxonomyReport:
    """Bring `universe_taxonomy` in step with the screened profiles, in the caller's transaction."""
    rows, unmapped = derive_rows(connection)
    written = 0
    for row in rows:
        result = connection.execute(
            text(
                """
                INSERT INTO universe_taxonomy (kind, name, sector, instruments)
                VALUES (:kind, :name, :sector, :instruments)
                ON CONFLICT (kind, name) DO UPDATE
                   SET sector      = EXCLUDED.sector,
                       instruments = EXCLUDED.instruments,
                       updated_at  = now()
                 WHERE (universe_taxonomy.sector, universe_taxonomy.instruments)
                       IS DISTINCT FROM (EXCLUDED.sector, EXCLUDED.instruments)
                """
            ),
            {
                "kind": row.kind,
                "name": row.name,
                "sector": row.sector,
                "instruments": row.instruments,
            },
        )
        written += int(result.rowcount or 0)
    removed = connection.execute(
        text(
            "DELETE FROM universe_taxonomy WHERE (kind, name) NOT IN ("
            "SELECT k, n FROM unnest(CAST(:kinds AS text[]), CAST(:names AS text[])) AS t(k, n))"
        ),
        {"kinds": [row.kind for row in rows], "names": [row.name for row in rows]},
    ).rowcount
    if unmapped:
        log.warning("universe.taxonomy_unmapped_categories", categories=unmapped)
    return TaxonomyReport(len(rows), written, int(removed or 0), unmapped)
