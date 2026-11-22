"""What is counted from one scan without a model: the eval's mechanical readings (D423).

Phase B reads four things from a scan. Three are facts in its transcript and are
counted here; the fourth - whether a thesis says what would prove it wrong - and
a reason repeated in other words need a reader, which is the judge's work.

- **A pass without a tool call**: the scan decided nothing and looked at nothing.
- **What the server sent back, by kind**: unsourced figures (D189), idle cash not
  addressed (D236), a mandate limit (D170), and what it refused for good.
- **A reason repeated word for word**: sentences of the thesis that already stood
  in one of the agent's last theses. Only the literal repeat is seen here.

It also counts what the frozen world could not answer, so a run that looks
different because prices were missing can be told from one that reasons differently.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from typing import Any

from app.agents.answer import UNSOURCED_PREFIX
from app.agents.scan import IDLE_CASH_PROBLEM, ScanResult

#: Sentences shorter than this are not compared: "No trade today." repeats by chance.
MIN_SENTENCE_LENGTH = 25
#: The kinds a problem sent back to the model is counted under.
RETURN_KINDS = ("figures", "idle_cash", "mandate")
#: Outcomes in which the agent decided nothing.
PASS_OUTCOME = "no_trade"

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+|\n+")
_SPACE = re.compile(r"\s+")


@dataclass
class Readings:
    outcome: str
    steps: int
    cost_micro_usd: int
    model: str | None
    tools: list[str]
    passed_without_tools: bool
    #: Problems the server sent back to the model, counted by kind.
    returned: dict[str, int]
    #: Trades in the final answer the server refused, by refusal code.
    refused: dict[str, int]
    cash_unjustified: bool
    trades: list[str]
    thesis: str | None
    sentences: int
    repeated_sentences: list[str] = field(default_factory=list)
    #: Tool answers that had no price or no closes to give: the world's gap, not the agent's.
    unpriced_answers: int = 0
    error: str | None = None

    def as_json(self) -> dict[str, Any]:
        return asdict(self)


def return_kind(problem: str) -> str:
    """Which of `RETURN_KINDS` a problem sent back to the model is."""
    if problem.startswith(UNSOURCED_PREFIX):
        return "figures"
    if problem == IDLE_CASH_PROBLEM:
        return "idle_cash"
    return "mandate"


def sentences(text: str | None) -> list[str]:
    """A thesis as comparable sentences: whitespace collapsed, short ones left out."""
    if not text:
        return []
    parts = (_SPACE.sub(" ", part).strip() for part in _SENTENCE_END.split(text))
    return [part for part in parts if len(part) >= MIN_SENTENCE_LENGTH]


def repeated(thesis: str | None, earlier: Sequence[str]) -> list[str]:
    """The thesis's sentences that stood, word for word, in an earlier thesis."""
    seen = {sentence for text in earlier for sentence in sentences(text)}
    return [sentence for sentence in sentences(thesis) if sentence in seen]


def _thesis(answer: dict[str, Any] | None) -> str | None:
    """Everything the scan wrote as its reasons: the overall thesis and each trade's."""
    if not answer:
        return None
    parts = [answer.get("thesis")] + [trade.get("thesis") for trade in answer.get("trades", [])]
    text = "\n".join(part for part in parts if isinstance(part, str) and part.strip())
    return text or None


def _unpriced(result: dict[str, Any]) -> bool:
    return bool(result.get("unpriced")) or result.get("closes") == []


def read_scan(result: ScanResult, earlier_theses: Sequence[str]) -> Readings:
    """The readings of one finished scan. `earlier_theses` are the agent's last theses
    in the world before the scan ran (`frozen_world.earlier_theses`)."""
    transcript = result.transcript
    tools = [
        str(call["name"])
        for entry in transcript
        if entry.get("role") == "assistant"
        for call in entry.get("tool_calls", [])
    ]
    returned = dict.fromkeys(RETURN_KINDS, 0)
    for entry in transcript:
        if entry.get("role") == "returned":
            for problem in entry.get("problems") or []:
                returned[return_kind(str(problem))] += 1
    answer = result.answer or {}
    refused: dict[str, int] = {}
    kept: list[str] = []
    for trade in answer.get("trades", []):
        if trade.get("refused"):
            code = str(trade.get("code", "unknown"))
            refused[code] = refused.get(code, 0) + 1
        else:
            kept.append(f"{trade.get('decision')} {trade.get('symbol')}")
    thesis = _thesis(result.answer)
    return Readings(
        outcome=result.outcome,
        steps=result.steps,
        cost_micro_usd=result.cost_micro_usd,
        model=result.model,
        tools=tools,
        passed_without_tools=result.outcome == PASS_OUTCOME and not tools,
        returned=returned,
        refused=refused,
        cash_unjustified=bool(answer.get("cash_unjustified")),
        trades=kept,
        thesis=thesis,
        sentences=len(sentences(thesis)),
        repeated_sentences=repeated(thesis, earlier_theses),
        unpriced_answers=sum(
            _unpriced(entry.get("result") or {})
            for entry in transcript
            if entry.get("role") == "tool" and isinstance(entry.get("result"), dict)
        ),
        error=result.error,
    )
