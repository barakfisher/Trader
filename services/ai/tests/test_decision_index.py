"""docs/DECISIONS.md must match the decisions in .claude/MEMORY.md.

The index is generated (scripts/build_decision_index.py). A generated file that
nothing checks is a hand-written file with extra steps: the first decision
written without re-running the script would leave the index quietly short.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_decision_index_is_up_to_date() -> None:
    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "build_decision_index.py"), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
