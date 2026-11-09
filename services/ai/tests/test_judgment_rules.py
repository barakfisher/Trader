"""The reasoning rules every agent is told, in a scan and in a research view."""

from __future__ import annotations

from app.agents.scan import JUDGMENT_RULES, PRICE_MOVE_RULE, instructions
from app.agents.scan_log import ScanAgent
from app.research.run import instructions as research_instructions

AGENT = ScanAgent("a", "u", "Ada", None, "active", False)


def test_a_scan_is_told_the_judgment_rules_and_the_price_move_rule() -> None:
    prompt = instructions(AGENT)
    assert JUDGMENT_RULES in prompt
    assert PRICE_MOVE_RULE in prompt


def test_research_is_told_the_judgment_rules_held_or_not() -> None:
    assert JUDGMENT_RULES in research_instructions(AGENT, held=True)
    assert JUDGMENT_RULES in research_instructions(AGENT, held=False)


def test_research_is_not_told_the_price_move_rule() -> None:
    """A research view trades nothing and does not open on the day's movers."""
    assert PRICE_MOVE_RULE not in research_instructions(AGENT, held=True)
