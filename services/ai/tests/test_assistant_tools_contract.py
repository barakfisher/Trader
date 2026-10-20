"""The assistant's tools agree with the code they describe, without a database."""

from __future__ import annotations

import re
from pathlib import Path

from app.assistant.product_guide import PAGES, SECTIONS
from app.assistant.tools import RESCREEN_DUE_DAYS, TOOLS_BY_NAME

ROOT = Path(__file__).resolve().parents[3]
RESCREEN = ROOT / "apps" / "orchestrator" / "src" / "services" / "universeRescreen.ts"
ROUTER = ROOT / "apps" / "web" / "src" / "router.tsx"


def test_the_rescreen_cadence_is_the_orchestrators() -> None:
    """`get_universe_info` tells a user how often the universe is rescreened; the
    orchestrator decides it. Two numbers that drift would make the answer wrong."""
    match = re.search(r"export const RESCREEN_DUE_DAYS = (\d+);", RESCREEN.read_text())

    assert match, "RESCREEN_DUE_DAYS not found in universeRescreen.ts"
    assert int(match.group(1)) == RESCREEN_DUE_DAYS


def test_every_tool_is_described_for_the_model() -> None:
    for name, tool in TOOLS_BY_NAME.items():
        assert tool.spec.name == name
        assert len(tool.spec.description) > 40, name
        assert tool.spec.parameters["type"] == "object", name


def test_the_pages_a_reply_may_link_are_the_routers() -> None:
    """A reply linking a page the router does not serve is sent back; a page the
    router added and this list lacks would be refused for no reason."""
    routed = {
        re.sub(r"\$[A-Za-z]+", "<id>", path)
        for path in re.findall(r"path: '(/[^']*)'", ROUTER.read_text())
    }

    assert set(PAGES) == routed


def test_the_guide_names_only_tools_the_assistant_has() -> None:
    """Gemini Flash-Lite read `get_position` in the agents section - an agent's
    tool, not the assistant's - and then tried to call it: Google ends that turn
    `MALFORMED_FUNCTION_CALL`, and "why can't I create an agent?" failed 9 times in
    10 (D226). Describe what another tool does; name only tools the model has."""
    named = {
        (section, name)
        for section, text in SECTIONS.items()
        for name in re.findall(r"\b[a-z]+(?:_[a-z]+)+\b", text)
    }

    assert {(section, name) for section, name in named if name not in TOOLS_BY_NAME} == set()
