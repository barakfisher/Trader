"""The scan's outcomes and triggers are one list each, in code and in the CHECKs.

Triggers were last rewritten by 0066 (`refresh`), outcomes by 0065 (`own_key_failed`).
A re-check has its own route (D212), so a scan request names every trigger but `refresh`."""

from __future__ import annotations

import importlib.util
import typing
from pathlib import Path
from types import ModuleType

from app.agents.scan_log import ScanOutcome, ScanTrigger
from app.models import AgentScanRequest, AgentScanResponse

VERSIONS = Path(__file__).parents[1] / "alembic" / "versions"
MIGRATION = VERSIONS / "0066_proposal_refresh.py"
OUTCOMES_MIGRATION = VERSIONS / "0065_own_llm_keys.py"


def _migration(path: Path = MIGRATION) -> ModuleType:
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_database_accepts_exactly_the_outcomes_and_triggers_the_code_writes() -> None:
    migration = _migration()
    assert set(_migration(OUTCOMES_MIGRATION).SCAN_OUTCOMES) == set(typing.get_args(ScanOutcome))
    assert set(migration.TRIGGERS) == set(typing.get_args(ScanTrigger))


def test_the_wire_names_the_same_outcomes_and_triggers() -> None:
    outcome = AgentScanResponse.model_fields["outcome"].annotation
    trigger = AgentScanRequest.model_fields["trigger"].annotation
    assert set(typing.get_args(outcome)) == set(typing.get_args(ScanOutcome))
    assert set(typing.get_args(trigger)) | {"refresh"} == set(typing.get_args(ScanTrigger))


def test_a_recheck_that_reached_no_answer_is_left_out_of_the_index_in_both() -> None:
    from app.agents.recheck import UNANSWERED_OUTCOMES

    assert set(_migration().UNANSWERED_OUTCOMES) == set(UNANSWERED_OUTCOMES)
