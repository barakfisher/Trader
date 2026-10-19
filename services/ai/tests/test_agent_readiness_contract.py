""" "Has a mandate" means the same thing to the AI service and the orchestrator (D174).

An agent scans when it has instructions or any setting. The AI service decides
that from `Mandate` (and `MANDATE_SET_SQL` for the assistant's own read); the
orchestrator from `MANDATE_COLUMNS` in `agentReadiness.ts`. A column one side
counts and the other does not would make an agent that the schedule skips but
"Run a scan now" runs - or the reverse - with nothing to say why.
"""

from __future__ import annotations

import re
from dataclasses import fields
from pathlib import Path

from app.agents.mandate import MANDATE_SET_SQL, Mandate

REPO_ROOT = Path(__file__).resolve().parents[3]
AGENT_QUERIES = REPO_ROOT / "apps" / "orchestrator" / "src" / "db" / "queries" / "agents.ts"


def _orchestrator_columns() -> set[str]:
    source = AGENT_QUERIES.read_text(encoding="utf-8")
    block = re.search(r"export const MANDATE_COLUMNS = \[(.*?)\]", source, re.S)
    assert block, "MANDATE_COLUMNS not found in agents.ts"
    return set(re.findall(r"'(\w+)'", block.group(1)))


def test_both_services_name_the_same_mandate_columns() -> None:
    assert {field.name for field in fields(Mandate)} == _orchestrator_columns()


def test_the_sql_reads_every_column() -> None:
    for column in _orchestrator_columns():
        assert f"a.{column}" in MANDATE_SET_SQL, column


def test_any_one_setting_is_a_mandate() -> None:
    assert not Mandate().is_set
    assert Mandate(allow_etfs=False).is_set
    assert Mandate(blocked_symbols=("XOM",)).is_set
    assert Mandate(risk_level=5).is_set
