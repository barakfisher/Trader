"""The approval's universe check bands a company as the scan does (D301).

The scan refuses a buy outside the agent's company sizes by `mandate.cap_band`;
the orchestrator repeats the rule at approval in `mandateLimits.ts`. A floor one
side moved and the other did not would warn of a buy the scan allowed, or let
the approval pass one the scan would refuse, with nothing to say which is right.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.agents.mandate import LARGE_CAP_FLOOR_MINOR, MEGA_CAP_FLOOR_MINOR, MID_CAP_FLOOR_MINOR

REPO_ROOT = Path(__file__).resolve().parents[3]
MANDATE_LIMITS = REPO_ROOT / "apps" / "orchestrator" / "src" / "services" / "mandateLimits.ts"


def _orchestrator_floor(name: str) -> int:
    source = MANDATE_LIMITS.read_text(encoding="utf-8")
    match = re.search(rf"export const {name} = ([\d_]+)n \* ([\d_]+)n;", source)
    assert match, f"{name} not found in mandateLimits.ts"
    return int(match.group(1).replace("_", "")) * int(match.group(2).replace("_", ""))


def test_both_services_band_companies_at_the_same_floors() -> None:
    assert _orchestrator_floor("MEGA_CAP_FLOOR_MINOR") == MEGA_CAP_FLOOR_MINOR
    assert _orchestrator_floor("LARGE_CAP_FLOOR_MINOR") == LARGE_CAP_FLOOR_MINOR
    assert _orchestrator_floor("MID_CAP_FLOOR_MINOR") == MID_CAP_FLOOR_MINOR
