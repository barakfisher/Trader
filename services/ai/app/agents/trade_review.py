"""An answer's trades against the agent's book, one after another (D197).

`answer.py` checks a trade on its own; this checks what depends on the rest:
what the agent holds, its cash, its mandate, the proposals already waiting and
the trades before it in the same answer. Sells are reviewed first, so a buy may
be paid for by a sell in the same answer - the buy then names it (`funded_by`)
and the user approves the sell first (D197, separate proposals).

**The book a trade is reviewed against is the book after every proposal that
could be approved**: the waiting buys as if filled (their cash spent, their
shares held - so approving all of them never fails for cash, and the mandate's
position and holdings limits count them), and the trades this answer already
kept. A waiting sell is not counted: it may be rejected.

Each refused trade carries a kind: `figures` and `mandate` may go back to the
model once each (D189, D170); everything else is `final` and is shown in the
scan with its reason. Nothing here writes.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from decimal import Decimal
from typing import Any

from sqlalchemy import text

from app.agents.answer import RefusalCode, Refused, Trade, agent_cash_minor, thesis_problems
from app.agents.mandate import Mandate, _Book, _profile, size_problems, universe_problems
from app.agents.pending_trades import PendingTrade
from app.agents.tools import ToolContext, find_listing, money
from app.core.fees import fee_minor, notional_minor


@dataclass
class _Position:
    quantity: Decimal
    #: Quantity times per-unit cost basis (D171).
    cost: Decimal


@dataclass
class TradeReview:
    """The running review of one scan's trades. `review` may be called again with
    the trades the model sent back; what was kept stays kept."""

    context: ToolContext
    mandate: Mandate
    max_decisions: int
    evidence: dict[str, Any]
    pending: Sequence[PendingTrade]
    #: A re-check's one trade, (side, symbol) (D216): any other is refused.
    focus: tuple[str, str] | None = None
    kept: list[Trade] = field(default_factory=list)
    _cash: int = 0
    _positions: dict[str, _Position] = field(default_factory=dict)
    #: Proceeds of the sells this answer kept, by symbol.
    _proceeds: dict[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        engine, user, agent = self.context.engine, self.context.user_id, self.context.agent_id
        self._cash = agent_cash_minor(engine, user, agent)
        with engine.connect() as connection:
            rows = connection.execute(
                text(
                    """
                    SELECT i.symbol, sum(h.quantity) AS quantity,
                           sum(h.quantity * coalesce(h.cost_basis_minor, 0)) AS cost
                      FROM holdings h JOIN instruments i ON i.id = h.instrument_id
                     WHERE h.user_id = CAST(:user AS uuid) AND h.agent_id = CAST(:agent AS uuid)
                       AND h.quantity > 0
                     GROUP BY i.symbol
                    """
                ),
                {"user": user, "agent": agent},
            ).all()
        self._positions = {
            row.symbol: _Position(Decimal(row.quantity), Decimal(row.cost)) for row in rows
        }
        for waiting in self.pending:
            if waiting.side == "buy":
                self._cash -= waiting.cost_minor
                self._add(waiting.symbol, waiting.quantity, waiting.price_minor)

    def _add(self, symbol: str, quantity: Decimal, price_minor: int) -> None:
        position = self._positions.setdefault(symbol, _Position(Decimal(0), Decimal(0)))
        position.quantity += quantity
        position.cost += notional_minor(quantity, price_minor)

    def _book(self, symbol: str) -> _Book:
        held = {s: p for s, p in self._positions.items() if p.quantity > 0}
        return _Book(
            cash_minor=self._cash,
            holdings_cost=sum((p.cost for p in held.values()), Decimal(0)),
            symbol_cost=held[symbol].cost if symbol in held else Decimal(0),
            held_symbols=frozenset(held),
        )

    async def review(self, trades: Sequence[Trade]) -> list[Refused]:
        """Keep each trade that may be proposed, in order, and answer the rest with why."""
        ordered = sorted(trades, key=lambda trade: trade.decision != "sell")
        symbols = sorted({trade.symbol for trade in ordered})
        quotes, _missing = await self.context.market.quotes(symbols) if symbols else ([], [])
        prices = {
            quote.symbol.upper(): quote
            for quote in quotes
            if quote.currency.upper() == "USD" and quote.price_minor > 0
        }
        refused: list[Refused] = []
        seen: set[str] = {trade.symbol for trade in self.kept}
        for trade in ordered:
            verdict = self._one(trade, prices, seen)
            seen.add(trade.symbol)
            if isinstance(verdict, Refused):
                refused.append(verdict)
            else:
                self.kept.append(verdict)
        return refused

    def _one(self, trade: Trade, prices: dict[str, Any], seen: set[str]) -> Trade | Refused:
        """Faults no second answer could mend come first, so a trade that has one is
        never sent back for its figures (D189: only an answer whose one fault is
        its figures goes back)."""
        if self.focus is not None and (trade.decision, trade.symbol) != self.focus:
            side, symbol = self.focus
            return _refuse(
                trade, f"not the trade being re-checked: {side} {symbol}", code="not_this_trade"
            )
        if len(self.kept) >= self.max_decisions:
            return _refuse(
                trade,
                f"over this agent's limit of {self.max_decisions} decisions a scan",
                code="decision_limit",
            )
        if trade.symbol in seen:
            return _refuse(trade, f"{trade.symbol} is already in this answer", code="duplicate")
        for waiting in self.pending:
            if waiting.side == trade.decision and waiting.symbol == trade.symbol:
                return _refuse(
                    trade,
                    f"{trade.decision} {trade.symbol} is already waiting for the user's approval",
                    code="already_waiting",
                )
        final: list[str] = []
        codes: list[RefusalCode] = []
        listing = find_listing(self.context.engine, trade.symbol)
        if listing is None or not listing.tradable:
            final.append(f"{trade.symbol} is not tradable: USD-listed, in the universe")
            codes.append("not_tradable")
        position = self._positions.get(trade.symbol)
        held = position.quantity if position else Decimal(0)
        if trade.decision == "sell" and held < trade.quantity:
            final.append(f"sells {trade.quantity} {trade.symbol} but holds {held.normalize():f}")
            codes.append("holding")
        too_long, figures = thesis_problems(trade, self.evidence)
        final += too_long
        codes += ["thesis"] * len(too_long)
        if final:
            return _refuse(trade, *final, *figures, code=codes[0])
        if figures:
            return _refuse(trade, *figures, kind="figures", code="figures")
        quote = prices.get(trade.symbol)
        if quote is None:
            return _refuse(trade, f"no USD price is available for {trade.symbol}", code="no_price")
        priced = replace(trade, price_minor=quote.price_minor, price_as_of=quote.as_of)
        quantity = Decimal(trade.quantity)
        notional = notional_minor(quantity, quote.price_minor)
        fee = fee_minor(quantity)
        if trade.decision == "sell":
            return self._sell(priced, quantity, notional, fee)
        return self._buy(priced, quantity, notional, fee)

    def _sell(self, trade: Trade, quantity: Decimal, notional: int, fee: int) -> Trade | Refused:
        if notional <= fee:
            return _refuse(
                trade,
                f"selling {trade.quantity} {trade.symbol} brings {money(notional, 'USD')}, "
                f"not more than the {money(fee, 'USD')} fee",
                code="too_small",
            )
        position = self._positions[trade.symbol]
        position.cost -= position.cost * quantity / position.quantity
        position.quantity -= quantity
        self._cash += notional - fee
        self._proceeds[trade.symbol] = notional - fee
        return trade

    def _buy(self, trade: Trade, quantity: Decimal, notional: int, fee: int) -> Trade | Refused:
        cost = notional + fee
        if cost > self._cash:
            price = money(trade.price_minor or 0, "USD")
            return _refuse(
                trade,
                f"buying {trade.quantity} {trade.symbol} at {price} costs {money(cost, 'USD')} "
                f"with the fee; cash after the other proposals is {money(self._cash, 'USD')}",
                code="cash",
            )
        broken = universe_problems(
            self.mandate, trade.symbol, _profile(self.context.engine, trade.symbol)
        ) + size_problems(self.mandate, trade, self._book(trade.symbol))
        if broken:
            return _refuse(trade, *broken, kind="mandate", code="mandate")
        # Paid for by this answer's sells when the cash before them would not cover it.
        if cost > self._cash - sum(self._proceeds.values()):
            trade = replace(trade, funded_by=tuple(self._proceeds))
        self._cash -= cost
        self._add(trade.symbol, quantity, trade.price_minor or 0)
        return trade


def _refuse(trade: Trade, *problems: str, code: RefusalCode, kind: str = "final") -> Refused:
    """A refused trade as written, with the price when one was read."""
    return Refused(trade.as_json(), problems, kind, code)  # type: ignore[arg-type]
