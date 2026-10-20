"""The agent's answer: the trades it decided, each with its own thesis (D14, D197).

A scan ends with one JSON object - up to the agent's `max_decisions` trades, or
none and why:

    {"trades": [{"decision": "sell", "symbol": "XOM", "quantity": "3", "thesis": "..."},
                {"decision": "buy",  "symbol": "CCJ", "quantity": "2", "thesis": "..."}]}
    {"trades": [], "thesis": "why nothing is worth doing"}

The one-trade shape every scan wrote before D197 - `{"decision", "symbol",
"quantity", "thesis"}` - is still read, so a model that answers in it is
understood and a stored scan still reads back.

This module parses an answer and checks each trade *on its own*: a symbol and
whole shares (D9), a thesis short enough to read, and every figure in it
sourced from the scan's evidence (§6.2, guideline 7). What depends on the other
trades and on the agent's book - holdings, cash, the mandate, the proposals
already waiting - is `trade_review.py`'s.

A problem is a reason string, never an exception: a trade that fails is stored
with its reasons, which the scan's history shows, not an error.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.narration.evidence_validator import unsourced_figures

Side = Literal["buy", "sell"]
SIDES: tuple[Side, ...] = ("buy", "sell")

#: A thesis long enough to say why, short enough to read before approving.
MAX_THESIS_CHARS = 1500
#: How a problem naming unsourced figures begins; the scan sends such a trade back once.
UNSOURCED_PREFIX = "figures not in the evidence"

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")


@dataclass(frozen=True)
class Trade:
    """One buy or sell the agent decided. The price and what funds it are the server's."""

    decision: Side
    symbol: str
    quantity: int
    thesis: str
    #: The agent's price, the quote when the trade was reviewed (D47).
    price_minor: int | None = None
    price_as_of: datetime | None = None
    #: Sells in the same answer whose proceeds this buy needs (D197): approve those first.
    funded_by: tuple[str, ...] = ()

    def as_json(self) -> dict[str, Any]:
        return {
            "decision": self.decision,
            "symbol": self.symbol,
            "quantity": str(self.quantity),
            "thesis": self.thesis,
            "price_minor": self.price_minor,
            "price_as_of": None if self.price_as_of is None else self.price_as_of.isoformat(),
            "funded_by": list(self.funded_by),
        }


@dataclass(frozen=True)
class Refused:
    """A trade the server will not propose, as the model wrote it, and why.

    `kind` says whether it may go back to the model: `figures` (D189) and
    `mandate` (D170) each get one chance; `final` never goes back.
    """

    written: dict[str, Any]
    problems: tuple[str, ...]
    kind: Literal["figures", "mandate", "final"] = "final"

    @property
    def symbol(self) -> str | None:
        symbol = self.written.get("symbol")
        return symbol.strip().upper() if isinstance(symbol, str) and symbol.strip() else None

    def as_json(self) -> dict[str, Any]:
        return {**self.written, "problems": list(self.problems), "refused": True}


@dataclass(frozen=True)
class ParsedAnswer:
    """The trades in an answer that are well formed, those that are not, and the overall thesis."""

    trades: tuple[Trade, ...]
    refused: tuple[Refused, ...]
    #: Why nothing is worth doing, when there are no trades; optional beside trades.
    thesis: str | None


def parse_answer(raw: str) -> tuple[ParsedAnswer | None, list[str]]:
    """The answer the model wrote, or why it is not one at all."""
    body = _FENCE.sub("", raw.strip())
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return None, ["the answer is not a JSON object"]
    if not isinstance(data, dict):
        return None, ["the answer is not a JSON object"]

    thesis = data.get("thesis")
    thesis = thesis.strip() if isinstance(thesis, str) and thesis.strip() else None
    if "trades" in data:
        written = data["trades"]
        if not isinstance(written, list):
            return None, ["trades must be a list"]
    elif data.get("decision") == "none":
        written = []
    elif "decision" in data:
        # The one-trade shape (before D197): the whole object is the trade.
        written, thesis = [data], None
    else:
        return None, ["the answer names its trades, or none"]
    if not written and thesis is None:
        return None, ["an answer with no trades says why"]

    trades: list[Trade] = []
    refused: list[Refused] = []
    for item in written:
        trade, problems = _parse_trade(item)
        if trade is None:
            refused.append(Refused(item if isinstance(item, dict) else {"written": item}, problems))
        else:
            trades.append(trade)
    return ParsedAnswer(tuple(trades), tuple(refused), thesis), []


def _parse_trade(item: object) -> tuple[Trade | None, tuple[str, ...]]:
    if not isinstance(item, dict):
        return None, ("a trade is a JSON object",)
    problems: list[str] = []
    decision = item.get("decision")
    if decision not in SIDES:
        problems.append(f"a trade's decision is one of {', '.join(SIDES)}")
    symbol = item.get("symbol")
    if not isinstance(symbol, str) or not symbol.strip():
        problems.append("a trade names a symbol")
    quantity = _whole_shares(item.get("quantity"))
    if quantity is None:
        problems.append("quantity is a whole number of shares, more than zero")
    thesis = item.get("thesis")
    if not isinstance(thesis, str) or not thesis.strip():
        problems.append("every trade has a thesis")
    if problems:
        return None, tuple(problems)
    return Trade(decision, symbol.strip().upper(), quantity, thesis.strip()), ()  # type: ignore[arg-type, union-attr]


def _whole_shares(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not number.is_finite() or number <= 0 or number != number.to_integral_value():
        return None
    return int(number)


def thesis_problems(trade: Trade, evidence: dict[str, Any]) -> tuple[list[str], list[str]]:
    """What is wrong with a trade's thesis: (final problems, unsourced-figure problems)."""
    final: list[str] = []
    if len(trade.thesis) > MAX_THESIS_CHARS:
        final.append(f"the thesis is longer than {MAX_THESIS_CHARS} characters")
    # The thesis may state the agent's own decision - "buy 2 shares" - which is
    # the answer, not a claim about the world, and so is in no tool's output.
    unsourced = unsourced_figures(trade.thesis, {**evidence, "proposed_quantity": trade.quantity})
    figures = [f"{UNSOURCED_PREFIX}: {', '.join(unsourced)}"] if unsourced else []
    return final, figures


def overall_thesis_problems(thesis: str | None, evidence: dict[str, Any]) -> list[str]:
    """A no-trade answer's reason is held to the same rules as a trade's thesis."""
    if thesis is None:
        return []
    problems: list[str] = []
    if len(thesis) > MAX_THESIS_CHARS:
        problems.append(f"the thesis is longer than {MAX_THESIS_CHARS} characters")
    if unsourced := unsourced_figures(thesis, evidence):
        problems.append(f"{UNSOURCED_PREFIX}: {', '.join(unsourced)}")
    return problems


def held_quantity(engine: Engine, user_id: str, agent_id: str, symbol: str) -> Decimal:
    with engine.connect() as connection:
        held = connection.execute(
            text(
                """
                SELECT coalesce(sum(h.quantity), 0)
                  FROM holdings h JOIN instruments i ON i.id = h.instrument_id
                 WHERE h.user_id = CAST(:user AS uuid) AND h.agent_id = CAST(:agent AS uuid)
                   AND i.symbol = :symbol
                """
            ),
            {"user": user_id, "agent": agent_id, "symbol": symbol},
        ).scalar_one()
    return Decimal(held)


def agent_cash_minor(engine: Engine, user_id: str, agent_id: str) -> int:
    with engine.connect() as connection:
        cash = connection.execute(
            text(
                "SELECT balance_minor FROM agent_cash "
                "WHERE agent_id = CAST(:agent AS uuid) AND user_id = CAST(:user AS uuid)"
            ),
            {"agent": agent_id, "user": user_id},
        ).scalar_one_or_none()
    return int(cash or 0)
