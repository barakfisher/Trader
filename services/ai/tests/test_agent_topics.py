"""An agent's topics (D412-D413): one limit, read the same by the migration's CHECK,
the briefing, and the shared constants the orchestrator and the web check input by."""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

from app.agents.briefing import MAX_TOPIC_LENGTH, MAX_TOPICS

SERVICE = Path(__file__).resolve().parents[1]


def test_the_migration_and_the_orchestrator_hold_the_briefings_limits() -> None:
    path = SERVICE / "alembic" / "versions" / "0090_agent_topics.py"
    spec = importlib.util.spec_from_file_location("m0090", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert (migration.MAX_TOPICS, migration.MAX_TOPIC_LENGTH) == (MAX_TOPICS, MAX_TOPIC_LENGTH)

    shared = (SERVICE.parents[1] / "packages/shared/src/types.ts").read_text()
    for name, value in (("MAX_TOPICS", MAX_TOPICS), ("MAX_TOPIC_LENGTH", MAX_TOPIC_LENGTH)):
        found = re.search(rf"export const {name} = (\d+);", shared)
        assert found and int(found.group(1)) == value, name
