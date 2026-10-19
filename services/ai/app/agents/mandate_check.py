"""Do an agent's instructions contradict its settings? One model call, after a save (D176-D178).

The form writes the instructions from the settings until the user edits them
(D174); text written that way cannot contradict them, so the page asks this only
when the instructions are the user's own words. The answer never blocks
anything: a contradiction is shown, and the user decides.

**The model names conflicts; it does not write the warning.** It answers which
setting each conflict is with and the number of the sentence that says it; the
instructions reach it as numbered sentences, and the quote is that sentence,
cut from the user's text here (D183). The sentence the user reads is built from
the catalogue in their language around that quote (D176). Nothing a model
writes reaches the user as if the user had written it (guideline 7) - by
construction, not by a check: the first real check found a contradiction and
lost it, because its copied Hebrew quote had one letter wrong.

**Skipped, quietly, rather than failed** when there is nothing to judge (no
instructions, no settings), when the agent's day's budget is spent, or when no
model answers. A check is a courtesy; its absence is never an error.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Literal

from app.agents.mandate import Mandate, percent, risk_band
from app.agents.scan_log import ScanAgent
from app.core.logging import get_logger
from app.llm.base import Caller, LLMBudgetExceededError, LLMError, LLMProvider

log = get_logger("agents.mandate_check")

#: What a conflict may name: the settings `settings_text` states.
Setting = Literal[
    "risk",
    "horizon",
    "style",
    "max_position",
    "cash_buffer",
    "max_holdings",
    "etfs",
    "market_caps",
    "sectors",
    "blocked",
]
SETTINGS: tuple[Setting, ...] = (
    "risk",
    "horizon",
    "style",
    "max_position",
    "cash_buffer",
    "max_holdings",
    "etfs",
    "market_caps",
    "sectors",
    "blocked",
)
SkipReason = Literal["no_instructions", "no_settings", "budget_spent", "no_model", "failed"]

#: Enough to name three conflicts; a check that writes more is not answering.
MAX_OUTPUT_TOKENS = 400
MAX_CONFLICTS = 3
#: A quote long enough to recognise, short enough to read inside a sentence.
MAX_QUOTE_CHARS = 160

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")
_SPACE = re.compile(r"\s+")
#: A sentence ends at . ! ? followed by space, or at a line break. A colon or a
#: semicolon does not end one: "You day-trade: you buy ..." is one thought.
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+|\n+")

SYSTEM = """You compare an investor's written instructions with the settings of their
simulated trading agent, and report clear contradictions only: places where the
instructions ask for something a setting rules out, or rule out something a
setting asks for. A difference of emphasis is not a contradiction, and neither is
something the settings do not cover.

The instructions are given as numbered sentences. Answer with JSON only, no
other text:
{"conflicts": [{"setting": "<one of the setting names given>",
                "sentence": <the number of the sentence that contradicts it>}]}
At most 3 conflicts. When there are none, answer {"conflicts": []}."""


@dataclass(frozen=True)
class Conflict:
    setting: Setting
    quote: str


@dataclass(frozen=True)
class CheckResult:
    status: Literal["checked", "skipped"]
    conflicts: tuple[Conflict, ...] = ()
    reason: SkipReason | None = None


def settings_text(mandate: Mandate) -> dict[Setting, str]:
    """Each set setting as the model reads it, by the name a conflict uses."""
    stated: dict[Setting, str] = {}
    if (band := risk_band(mandate.risk_level)) is not None:
        stated["risk"] = f"{band} ({mandate.risk_level} of 10)"
    if mandate.horizon:
        stated["horizon"] = {
            "short": "short-term: days to a few weeks",
            "medium": "medium-term: weeks to a few months",
            "long": "long-term: months to years",
        }.get(mandate.horizon, mandate.horizon)
    if mandate.thesis_style:
        stated["style"] = {
            "academic": "conservative and academic",
            "growth": "bullish, growth-minded",
            "contrarian": "contrarian",
        }.get(mandate.thesis_style, mandate.thesis_style)
    if mandate.max_position_bps is not None:
        limit = percent(mandate.max_position_bps)
        stated["max_position"] = f"at most {limit}% of capital in one position"
    if mandate.cash_buffer_bps is not None:
        floor = percent(mandate.cash_buffer_bps)
        stated["cash_buffer"] = f"at least {floor}% of capital kept in cash"
    if mandate.max_holdings is not None:
        stated["max_holdings"] = f"at most {mandate.max_holdings} holdings at once"
    if not mandate.allow_etfs:
        stated["etfs"] = "ETFs are not bought"
    if mandate.market_caps:
        stated["market_caps"] = "stocks of these sizes only: " + ", ".join(mandate.market_caps)
    where = [*mandate.sectors, *mandate.industries, *mandate.etf_categories]
    if where:
        stated["sectors"] = "buys only in: " + ", ".join(where)
    if mandate.blocked_symbols:
        stated["blocked"] = "never buys: " + ", ".join(mandate.blocked_symbols)
    return stated


def _normal(text: str) -> str:
    return _SPACE.sub(" ", text).strip()


def sentences(instructions: str) -> list[str]:
    """The instructions as the model sees them numbered: 1 is the first."""
    return [_normal(part) for part in _SENTENCE_END.split(instructions) if part.strip()]


def _quote(sentence: str) -> str:
    """The sentence, or its first words when it is too long to read inside the warning."""
    if len(sentence) <= MAX_QUOTE_CHARS:
        return sentence
    cut = sentence[: MAX_QUOTE_CHARS - 1]
    return (cut.rsplit(" ", 1)[0] or cut) + "…"


def parse_conflicts(
    raw: str, instructions: str, stated: dict[Setting, str]
) -> tuple[Conflict, ...] | None:
    """The conflicts named that hold up; None when the answer is not the JSON asked for."""
    try:
        data = json.loads(_FENCE.sub("", raw.strip()))
    except json.JSONDecodeError:
        return None
    items = data.get("conflicts") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return None
    numbered = sentences(instructions)
    kept: list[Conflict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        setting, number = item.get("setting"), item.get("sentence")
        # bool is an int in Python; `true` is not a sentence number.
        if setting not in stated or not isinstance(number, int) or isinstance(number, bool):
            continue
        if not 1 <= number <= len(numbered):
            log.warning("agents.mandate_check_no_such_sentence", sentence=number, of=len(numbered))
            continue
        quote = _quote(numbered[number - 1])
        if any(conflict.setting == setting and conflict.quote == quote for conflict in kept):
            continue
        kept.append(Conflict(setting, quote))  # type: ignore[arg-type]
    return tuple(kept[:MAX_CONFLICTS])


def _user_prompt(instructions: str, stated: dict[Setting, str]) -> str:
    settings = "\n".join(f"- {name}: {text}" for name, text in stated.items())
    numbered = "\n".join(f"{n}. {text}" for n, text in enumerate(sentences(instructions), 1))
    return f"Settings, by name:\n{settings}\n\nInstructions, by sentence:\n{numbered}"


async def check_instructions(llm: LLMProvider, agent: ScanAgent) -> CheckResult:
    """Judge `agent`'s instructions against its mandate. The caller has checked the budget."""
    instructions = (agent.persona or "").strip()
    if not instructions:
        return CheckResult("skipped", reason="no_instructions")
    stated = settings_text(agent.mandate)
    if not stated:
        return CheckResult("skipped", reason="no_settings")
    try:
        completion = await llm.complete(
            system=SYSTEM,
            user=_user_prompt(instructions, stated),
            max_output_tokens=MAX_OUTPUT_TOKENS,
            temperature=0,
            caller=Caller("mandate_check", user_id=agent.user_id, agent_id=agent.agent_id),
        )
    except LLMBudgetExceededError:
        return CheckResult("skipped", reason="budget_spent")
    except LLMError as error:
        log.warning("agents.mandate_check_failed", agent_id=agent.agent_id, error=str(error))
        return CheckResult("skipped", reason="failed")
    conflicts = parse_conflicts(completion.text, instructions, stated)
    verdict = "accepted" if conflicts is not None else "malformed"
    await llm.record_verdict(completion.call_id, verdict)
    if conflicts is None:
        return CheckResult("skipped", reason="failed")
    return CheckResult("checked", conflicts)
