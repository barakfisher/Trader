"""The reasoning rules every agent is told, in a scan and in a research view, and the
briefing sections a scan is told about."""

from __future__ import annotations

from app.agents.briefing import NEW_IN_UNIVERSE_KEY, UPCOMING_IPOS_KEY
from app.agents.scan import (
    JUDGMENT_RULES,
    NEW_LISTINGS_LINE,
    PRICE_MOVE_RULE,
    UPCOMING_IPO_RULE,
    instructions,
)
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


def test_a_scan_is_told_the_new_sections_and_that_an_upcoming_ipo_is_not_tradable() -> None:
    # D411: the briefing's two sections from the new-listings plan.
    prompt = instructions(AGENT)
    assert NEW_LISTINGS_LINE in prompt
    assert UPCOMING_IPO_RULE in prompt
    assert f'"{NEW_IN_UNIVERSE_KEY}"' in prompt and f'"{UPCOMING_IPOS_KEY}"' in prompt


def test_research_is_not_told_the_briefing_sections() -> None:
    # A research view has no scan briefing; naming its sections would invite a search.
    prompt = research_instructions(AGENT, held=False)
    assert UPCOMING_IPOS_KEY not in prompt
    assert NEW_IN_UNIVERSE_KEY not in prompt
