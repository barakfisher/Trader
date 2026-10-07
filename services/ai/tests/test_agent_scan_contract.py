"""The scan's outcomes and triggers are one list each, in code and in 0043's CHECKs."""

from __future__ import annotations

import importlib.util
import typing
from pathlib import Path
from types import ModuleType

from app.agents.scan_log import ScanOutcome, ScanTrigger
from app.models import AgentScanRequest, AgentScanResponse

MIGRATION = Path(__file__).parents[1] / "alembic" / "versions" / "0043_agent_scans.py"


def _migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location(MIGRATION.stem, MIGRATION)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_database_accepts_exactly_the_outcomes_and_triggers_the_code_writes() -> None:
    migration = _migration()
    assert set(migration.OUTCOMES) == set(typing.get_args(ScanOutcome))
    assert set(migration.TRIGGERS) == set(typing.get_args(ScanTrigger))


def test_the_wire_names_the_same_outcomes_and_triggers() -> None:
    outcome = AgentScanResponse.model_fields["outcome"].annotation
    trigger = AgentScanRequest.model_fields["trigger"].annotation
    assert set(typing.get_args(outcome)) == set(typing.get_args(ScanOutcome))
    assert set(typing.get_args(trigger)) == set(typing.get_args(ScanTrigger))
