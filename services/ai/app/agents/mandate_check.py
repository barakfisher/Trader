"""Do an agent's instructions contradict its settings? One model call, after a save (D176-D178).

The form writes the instructions from the settings until the user edits them
(D174); text written that way cannot contradict them, so the page asks this only
when the instructions are the user's own words. The answer never blocks
anything: a contradiction is shown, and the user decides.

**The model names conflicts; it does not write the warning.** It answers which
setting each conflict is with and an exact quote from the instructions. The
sentence the user reads is built from the catalogue in their language around
that quote (D176). A quote the instructions do not contain is dropped - the
same rule the evidence validator applies to figures (guideline 7): nothing a
model invents reaches the user as if the user had written it.

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

SYSTEM = """You compare an investor's written instructions with the settings of their
simulated trading agent, and report clear contradictions only: places where the
instructions ask for something a setting rules out, or rule out something a
setting asks for. A difference of emphasis is not a contradiction, and neither is
something the settings do not cover.

Answer with JSON only, no other text:
{"conflicts": [{"setting": "<one of the setting names given>",
                "quote": "<words copied exactly from the instructions>"}]}
Copy each quote character for character from the instructions, in their own
language, at most 160 characters. At most 3 conflicts. When there are none,
answer {"conflicts": []}."""


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
    haystack = _normal(instructions)
    kept: list[Conflict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        setting, quote = item.get("setting"), item.get("quote")
        if setting not in stated or not isinstance(quote, str):
            continue
        quote = _normal(quote)
        # The quote must be the user's words, or it is not shown as theirs.
        if not quote or len(quote) > MAX_QUOTE_CHARS or quote not in haystack:
            continue
        if any(conflict.setting == setting and conflict.quote == quote for conflict in kept):
            continue
        kept.append(Conflict(setting, quote))  # type: ignore[arg-type]
    return tuple(kept[:MAX_CONFLICTS])


def _user_prompt(instructions: str, stated: dict[Setting, str]) -> str:
    settings = "\n".join(f"- {name}: {text}" for name, text in stated.items())
    return f"Settings, by name:\n{settings}\n\nInstructions:\n{instructions}"


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
