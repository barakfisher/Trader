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

Not checked here, and why: whether cash covers cost plus fee (D3, D6) needs the
live price and the fee rule at the moment a proposal is written, which is PR 5's
- the proposal is where money is committed, and a check made now would be stale
by then. The thesis's language (D51) arrives with the proposal too.

A problem is a reason string, never an exception: an answer that fails is
stored with its reasons as `invalid_answer`, which is a scan outcome the
*Decisions* tab shows, not an error.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.agents.tools import find_listing
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

    def as_json(self) -> dict[str, Any]:
        return {
            "decision": self.decision,
            "symbol": self.symbol,
            "quantity": None if self.quantity is None else str(self.quantity),
            "thesis": self.thesis,
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
