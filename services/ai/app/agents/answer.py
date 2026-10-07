"""The agent's answer, and the server's checks on it (D14).

A scan ends with one JSON object: buy, sell or none, and why. The decision is
the model's; the limits are the code's, applied here *after* it has answered and
whatever it said:

- the symbol is tradable: in the universe, not dropped, priced in USD (D7, D8);
- the quantity is a whole number of shares, more than zero (D9);
- a sell does not exceed what the agent holds;
- every figure in the thesis appears in what the briefing and the tools returned
  (§6.2, guideline 7) - the same validator narration uses, over the scan's own
  evidence.

Then, for a buy or sell that passed, `price_answer` reads the price the
proposal will carry - the agent's price (D47) - and checks that cash covers
cost plus fee at that price (D54, D55). It runs at the end of the scan, not when
the orchestrator writes the proposal seconds later, so the scan's stored outcome
is always the true one: a buy the agent cannot pay for is `invalid_answer`
with the amounts, never a `trade` that silently proposed nothing.

A problem is a reason string, never an exception: an answer that fails is
stored with its reasons as `invalid_answer`, which is a scan outcome the
*Decisions* tab shows, not an error.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, replace
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.agents.tools import ToolContext, find_listing, money
from app.core.fees import fee_minor, notional_minor
from app.narration.evidence_validator import unsourced_figures

Decision = Literal["buy", "sell", "none"]
DECISIONS: tuple[Decision, ...] = ("buy", "sell", "none")

#: A thesis long enough to say why, short enough to read before approving.
MAX_THESIS_CHARS = 1500

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")


@dataclass(frozen=True)
class Answer:
    decision: Decision
    symbol: str | None
    quantity: int | None
    thesis: str
    #: The agent's price for a trade, set by `price_answer` (D47).
    price_minor: int | None = None
    price_as_of: datetime | None = None

    def as_json(self) -> dict[str, Any]:
        return {
            "decision": self.decision,
            "symbol": self.symbol,
            "quantity": None if self.quantity is None else str(self.quantity),
            "thesis": self.thesis,
            "price_minor": self.price_minor,
            "price_as_of": None if self.price_as_of is None else self.price_as_of.isoformat(),
        }


@dataclass(frozen=True)
class CheckedAnswer:
    answer: Answer | None
    problems: tuple[str, ...]

    @property
    def valid(self) -> bool:
        return self.answer is not None and not self.problems


def parse_answer(raw: str) -> tuple[Answer | None, list[str]]:
    """The answer the model wrote, or why it is not one."""
    body = _FENCE.sub("", raw.strip())
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return None, ["the answer is not a JSON object"]
    if not isinstance(data, dict):
        return None, ["the answer is not a JSON object"]

    decision = data.get("decision")
    if decision not in DECISIONS:
        return None, [f"decision must be one of {', '.join(DECISIONS)}"]
    thesis = data.get("thesis")
    if not isinstance(thesis, str) or not thesis.strip():
        return None, ["a thesis is required, even for no trade"]
    thesis = thesis.strip()
    if decision == "none":
        return Answer("none", None, None, thesis), []

    problems: list[str] = []
    symbol = data.get("symbol")
    if not isinstance(symbol, str) or not symbol.strip():
        problems.append("a buy or sell names a symbol")
        symbol = None
    quantity = _whole_shares(data.get("quantity"))
    if quantity is None:
        problems.append("quantity is a whole number of shares, more than zero")
    if problems:
        return None, problems
    return Answer(decision, symbol.strip().upper(), quantity, thesis), []  # type: ignore[union-attr]


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


def check_answer(
    raw: str,
    *,
    engine: Engine,
    user_id: str,
    agent_id: str,
    evidence: dict[str, Any],
) -> CheckedAnswer:
    answer, problems = parse_answer(raw)
    if answer is None:
        return CheckedAnswer(None, tuple(problems))

    if len(answer.thesis) > MAX_THESIS_CHARS:
        problems.append(f"the thesis is longer than {MAX_THESIS_CHARS} characters")
    # The thesis may state the agent's own decision - "buy 2 shares" - which is
    # the answer, not a claim about the world, and so is in no tool's output.
    if answer.quantity is not None:
        evidence = {**evidence, "proposed_quantity": answer.quantity}
    unsourced = unsourced_figures(answer.thesis, evidence)
    if unsourced:
        problems.append(f"figures not in the evidence: {', '.join(unsourced)}")

    if answer.decision != "none" and answer.symbol and answer.quantity:
        listing = find_listing(engine, answer.symbol)
        if listing is None or not listing.tradable:
            problems.append(f"{answer.symbol} is not tradable: USD-listed, in the universe")
        if answer.decision == "sell":
            held = held_quantity(engine, user_id, agent_id, answer.symbol)
            if held < answer.quantity:
                problems.append(f"sells {answer.quantity} {answer.symbol} but holds {held:f}")
    return CheckedAnswer(answer, tuple(problems))


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


async def price_answer(context: ToolContext, checked: CheckedAnswer) -> CheckedAnswer:
    """A valid buy or sell, with the agent's price on it, or why it cannot be proposed.

    The price is the quote now, the one the orchestrator writes on the proposal.
    Only a buy spends cash: `notional + fee` must fit (D6, D54). A sell's fee
    comes out of its proceeds, and `executeFill` refuses one that would not.
    """
    answer = checked.answer
    if not checked.valid or answer is None or answer.decision == "none":
        return checked
    assert answer.symbol is not None and answer.quantity is not None
    quotes, _missing = await context.market.quotes([answer.symbol])
    quote = next((q for q in quotes if q.symbol.upper() == answer.symbol), None)
    if quote is None or quote.currency.upper() != "USD" or quote.price_minor <= 0:
        return CheckedAnswer(answer, (f"no USD price is available for {answer.symbol}",))
    priced = replace(answer, price_minor=quote.price_minor, price_as_of=quote.as_of)
    if answer.decision == "buy":
        notional = notional_minor(Decimal(answer.quantity), quote.price_minor)
        cost = notional + fee_minor(notional)
        cash = agent_cash_minor(context.engine, context.user_id, context.agent_id)
        if cost > cash:
            price = money(quote.price_minor, "USD")
            return CheckedAnswer(
                priced,
                (
                    f"buying {answer.quantity} {answer.symbol} at {price} "
                    f"costs {money(cost, 'USD')} with the fee; cash is {money(cash, 'USD')}",
                ),
            )
    return CheckedAnswer(priced, ())
