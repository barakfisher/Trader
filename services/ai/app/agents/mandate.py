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
from decimal import Decimal
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.agents.answer import Answer, agent_cash_minor
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


def mandate_brief(mandate: Mandate) -> dict[str, Any] | None:
    """The enforced rules as the briefing states them, or None when there are none.

    In the briefing rather than only the prompt, so a thesis that quotes a limit
    ("within my 10% cap") quotes evidence the validator can find.
    """
    brief: dict[str, Any] = {}
    if mandate.max_position_bps is not None:
        brief["max_position_pct_of_capital"] = percent(mandate.max_position_bps)
    if mandate.cash_buffer_bps is not None:
        brief["min_cash_pct_of_capital"] = percent(mandate.cash_buffer_bps)
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


def _book(engine: Engine, user_id: str, agent_id: str, symbol: str) -> _Book:
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                SELECT i.symbol, h.quantity, h.cost_basis_minor
                  FROM holdings h JOIN instruments i ON i.id = h.instrument_id
                 WHERE h.user_id = CAST(:user AS uuid) AND h.agent_id = CAST(:agent AS uuid)
                   AND h.quantity > 0
                """
            ),
            {"user": user_id, "agent": agent_id},
        ).all()
    costs = [(row.symbol, Decimal(row.quantity) * int(row.cost_basis_minor or 0)) for row in rows]
    return _Book(
        cash_minor=agent_cash_minor(engine, user_id, agent_id),
        holdings_cost=sum((cost for _, cost in costs), Decimal(0)),
        symbol_cost=sum((cost for held, cost in costs if held == symbol), Decimal(0)),
        held_symbols=frozenset(held for held, _ in costs),
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


def size_problems(mandate: Mandate, answer: Answer, book: _Book) -> list[str]:
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


def mandate_problems(
    engine: Engine, user_id: str, agent_id: str, mandate: Mandate, answer: Answer
) -> list[str]:
    """Every rule a priced answer breaks. A sell or a no-trade breaks none."""
    if answer.decision != "buy" or answer.symbol is None:
        return []
    problems = universe_problems(mandate, answer.symbol, _profile(engine, answer.symbol))
    sized = (mandate.max_position_bps, mandate.cash_buffer_bps, mandate.max_holdings)
    if all(limit is None for limit in sized):
        return problems
    book = _book(engine, user_id, agent_id, answer.symbol)
    return problems + size_problems(mandate, answer, book)
