"""An agent's mandate, and the code's check of a trade against it (D165, D171-D173).

The template creator writes the mandate onto `agents` (migration 0057). Part of
it only shapes the prompt - risk band, horizon, thesis style - and part of it is
**enforced here**, after the answer is checked and priced and before it can
become a proposal, because a rule given only to a model is a suggestion it
sometimes ignores:

- **Universe** - blocked symbols, the ETF ban, market-cap bands for equities,
  and the "Sectors & industries" selection. A ticker on the blocked list is
  never bought; there is no allow-list (D173).
- **Position size and cash buffer**, in basis points of the agent's capital,
  **cash plus holdings at cost** (D171): what the ledger holds exactly, so no
  unpriced holding can make the rule unanswerable. Compared exactly, as
  integers and Decimals - nothing is rounded to decide a limit.
- **Max holdings**: buying an instrument the agent does not hold, when it
  already holds that many, is refused.

**Only buys are checked.** A sell is always allowed, so tightening a rule can
never trap a position the agent already holds (D165).

A problem is an English sentence naming the rule and the figures. It goes back
to the model once (`scan.py`, D170), and is stored on the scan if the second
answer breaks a rule too.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_FLOOR, Decimal
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.agents.answer import Trade
from app.agents.tools import money
from app.core.fees import fee_minor, notional_minor
from app.universe.taxonomy import category_sector

BPS = 10_000

#: Market-cap bands for equities, in USD minor units (D172). A band is
#: [floor, next band's floor); "small" has no floor here because the screen's
#: own floor already bounds the universe.
MEGA_CAP_FLOOR_MINOR = 200_000_000_000 * 100
LARGE_CAP_FLOOR_MINOR = 10_000_000_000 * 100
MID_CAP_FLOOR_MINOR = 2_000_000_000 * 100

#: The prompt's words for the 1-10 risk slider (D169): five bands of two.
RISK_BANDS = ("Ultra-conservative", "Conservative", "Balanced", "Growth", "Aggressive")


@dataclass(frozen=True)
class Mandate:
    risk_level: int | None = None
    horizon: str | None = None
    thesis_style: str | None = None
    max_position_bps: int | None = None
    cash_buffer_bps: int | None = None
    max_holdings: int | None = None
    allow_etfs: bool = True
    market_caps: tuple[str, ...] = ()
    sectors: tuple[str, ...] = ()
    industries: tuple[str, ...] = ()
    etf_categories: tuple[str, ...] = ()
    blocked_symbols: tuple[str, ...] = ()

    @property
    def selects_classifications(self) -> bool:
        return bool(self.sectors or self.industries or self.etf_categories)

    @property
    def is_set(self) -> bool:
        """Whether any setting differs from no-limit: enough, alone, to scan by (D174)."""
        return self != Mandate()


#: `Mandate.is_set` in SQL, over an `agents` row aliased `a`. The orchestrator's
#: `agentReadiness.ts` says the same; `test_agent_readiness_contract.py` holds them equal.
MANDATE_SET_SQL = (
    "(a.risk_level IS NOT NULL OR a.horizon IS NOT NULL OR a.thesis_style IS NOT NULL"
    " OR a.max_position_bps IS NOT NULL OR a.cash_buffer_bps IS NOT NULL"
    " OR a.max_holdings IS NOT NULL OR NOT a.allow_etfs"
    " OR cardinality(a.market_caps) > 0 OR cardinality(a.sectors) > 0"
    " OR cardinality(a.industries) > 0 OR cardinality(a.etf_categories) > 0"
    " OR cardinality(a.blocked_symbols) > 0)"
)


def ready_to_scan(persona: str | None, mandate_set: bool) -> bool:
    """D174: an agent decides by its instructions, its mandate, or both - never by neither."""
    return bool((persona or "").strip()) or mandate_set


def risk_band(level: int | None) -> str | None:
    return None if level is None else RISK_BANDS[(level - 1) // 2]


def percent(bps: int) -> str:
    """Basis points as the percentage a person reads: 1000 -> "10", 1250 -> "12.5"."""
    return f"{(Decimal(bps) / 100).normalize():f}"


def cap_band(market_cap_minor: int) -> str:
    if market_cap_minor >= MEGA_CAP_FLOOR_MINOR:
        return "mega"
    if market_cap_minor >= LARGE_CAP_FLOOR_MINOR:
        return "large"
    if market_cap_minor >= MID_CAP_FLOOR_MINOR:
        return "mid"
    return "small"


def cash_above_buffer(
    mandate: Mandate, cash_minor: int, holdings_cost: Decimal
) -> dict[str, str] | None:
    """The cash above the agent's buffer, for the briefing (D235); None when there is none.

    Capital is cash plus holdings at cost, as for every limit (D171), and the cash is what
    remains after the waiting buys. The amount is rounded down to the cent, once: it is
    cash the agent has, never more. The percent is of capital, to one place, under a key
    the figure check reads as a percent - a key with "pct" in it is read as a ratio, so
    "75%" would not match it. No buffer set is a buffer of zero.
    """
    capital = cash_minor + holdings_cost
    buffer = Decimal(mandate.cash_buffer_bps or 0) * capital / BPS
    amount = int((cash_minor - buffer).to_integral_value(rounding=ROUND_FLOOR))
    if amount <= 0:
        return None
    share = (Decimal(amount) * 100 / capital).quantize(Decimal("0.1"))
    return {"amount": money(amount, "USD"), "percent_of_capital": f"{share.normalize():f}"}


def mandate_brief(mandate: Mandate) -> dict[str, Any] | None:
    """The enforced rules as the briefing states them, or None when there are none.

    In the briefing rather than only the prompt, so a thesis that quotes a limit
    ("within my 10% cap") quotes evidence the validator can find.
    """
    brief: dict[str, Any] = {}
    # Named "percent", not "pct": the figure check reads a "pct" key as a ratio and
    # would offer 2500% for the value 25 (D235 found this; see evidence_validator).
    if mandate.max_position_bps is not None:
        brief["max_position_percent_of_capital"] = percent(mandate.max_position_bps)
    if mandate.cash_buffer_bps is not None:
        brief["min_cash_percent_of_capital"] = percent(mandate.cash_buffer_bps)
    if mandate.max_holdings is not None:
        brief["max_holdings"] = mandate.max_holdings
    if not mandate.allow_etfs:
        brief["etfs_allowed"] = False
    if mandate.market_caps:
        brief["equity_market_caps"] = list(mandate.market_caps)
    if mandate.sectors:
        brief["sectors"] = list(mandate.sectors)
    if mandate.industries:
        brief["industries"] = list(mandate.industries)
    if mandate.etf_categories:
        brief["etf_categories"] = list(mandate.etf_categories)
    if mandate.blocked_symbols:
        brief["blocked_symbols"] = list(mandate.blocked_symbols)
    return brief or None


@dataclass(frozen=True)
class _Profile:
    asset_class: str
    sector: str | None
    industry: str | None
    category: str | None
    market_cap_minor: int | None
    size_currency: str | None


@dataclass(frozen=True)
class _Book:
    cash_minor: int
    #: Holdings at cost: quantity times per-unit cost basis, summed (D171).
    holdings_cost: Decimal
    symbol_cost: Decimal
    held_symbols: frozenset[str]

    @property
    def capital(self) -> Decimal:
        return self.cash_minor + self.holdings_cost


def _profile(engine: Engine, symbol: str) -> _Profile | None:
    with engine.connect() as connection:
        row = connection.execute(
            text(
                """
                SELECT i.asset_class, p.sector, p.industry, p.category,
                       p.market_cap_minor, p.size_currency
                  FROM instruments i
                  LEFT JOIN instrument_profiles p ON p.instrument_id = i.id
                 WHERE i.symbol = :symbol
                """
            ),
            {"symbol": symbol},
        ).one_or_none()
    if row is None:
        return None
    return _Profile(
        row.asset_class,
        row.sector,
        row.industry,
        row.category,
        row.market_cap_minor,
        row.size_currency,
    )


def universe_problems(mandate: Mandate, symbol: str, profile: _Profile | None) -> list[str]:
    """Why `symbol` is outside the agent's universe; empty when it is inside."""
    if symbol in mandate.blocked_symbols:
        return [f"{symbol} is on this agent's blocked list"]
    if profile is None:
        return [f"{symbol} has no profile to check against this agent's universe"]
    is_etf = profile.asset_class == "etf"
    problems: list[str] = []
    if is_etf and not mandate.allow_etfs:
        problems.append(f"{symbol} is an ETF; this agent does not buy ETFs")
    if not is_etf and mandate.market_caps:
        if profile.market_cap_minor is None or (profile.size_currency or "").upper() != "USD":
            problems.append(f"{symbol} has no stored market cap, so its size cannot be checked")
        elif (band := cap_band(profile.market_cap_minor)) not in mandate.market_caps:
            allowed = ", ".join(mandate.market_caps)
            problems.append(f"{symbol} is a {band}-cap; this agent buys only {allowed}-caps")
    if mandate.selects_classifications and not _in_selection(mandate, profile):
        where = (
            f"ETF category {profile.category!r}"
            if is_etf
            else f"{profile.sector or 'no sector'} / {profile.industry or 'no industry'}"
        )
        problems.append(f"{symbol} ({where}) is outside this agent's sectors and industries")
    return problems


def _in_selection(mandate: Mandate, profile: _Profile) -> bool:
    if profile.asset_class == "etf":
        if profile.category is None:
            return False
        return (
            profile.category in mandate.etf_categories
            or category_sector(profile.category) in mandate.sectors
        )
    return profile.sector in mandate.sectors or profile.industry in mandate.industries


def size_problems(mandate: Mandate, answer: Trade, book: _Book) -> list[str]:
    """Why a priced buy breaks the position, cash or holdings rules; empty when it does not."""
    assert answer.symbol is not None and answer.quantity is not None
    assert answer.price_minor is not None
    quantity = Decimal(answer.quantity)
    notional = notional_minor(quantity, answer.price_minor)
    capital = book.capital
    problems: list[str] = []
    if mandate.max_position_bps is not None:
        after = book.symbol_cost + notional
        if after * BPS > mandate.max_position_bps * capital:
            problems.append(
                f"{answer.symbol} would be {money(int(after), 'USD')} at cost, over the "
                f"{percent(mandate.max_position_bps)}% position limit of capital "
                f"{money(int(capital), 'USD')}"
            )
    if mandate.cash_buffer_bps is not None:
        cash_after = book.cash_minor - notional - fee_minor(quantity)
        if cash_after * BPS < mandate.cash_buffer_bps * capital:
            problems.append(
                f"cash would fall to {money(cash_after, 'USD')}, under the "
                f"{percent(mandate.cash_buffer_bps)}% minimum of capital "
                f"{money(int(capital), 'USD')}"
            )
    if (
        mandate.max_holdings is not None
        and answer.symbol not in book.held_symbols
        and len(book.held_symbols) >= mandate.max_holdings
    ):
        problems.append(
            f"this agent holds {len(book.held_symbols)} instruments, its limit; "
            f"{answer.symbol} would be one more"
        )
    return problems
