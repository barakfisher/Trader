"""`DatabaseCallLog` against a real Postgres: a call and its verdict are one row,
and the insert itself deletes whatever has outlived the retention window."""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.llm.call_log import CallEntry, DatabaseCallLog

SEED_USER = "00000000-0000-0000-0000-000000000001"


def _entry(prompt: str) -> CallEntry:
    return CallEntry(
        agent="narration",
        user_id=SEED_USER,
        provider="openrouter",
        model="stub-model",
        outcome="ok",
        error=None,
        latency_ms=812,
        prompt_tokens=120,
        completion_tokens=40,
        cost_micro_usd=231,
        prompt=prompt,
        completion="{}",
    )


def test_a_call_and_its_verdict_are_one_row(migrated: Engine) -> None:
    log = DatabaseCallLog(migrated, retention_days=30)
    call_id = log.record(_entry("verdict-check"))
    log.set_verdict(call_id, "unsourced_figures")
    with migrated.begin() as connection:
        row = connection.execute(
            text(
                "SELECT verdict, cost_micro_usd, user_id::text AS user_id "
                "FROM llm_calls WHERE id = :id"
            ),
            {"id": call_id},
        ).one()
        connection.execute(text("DELETE FROM llm_calls WHERE id = :id"), {"id": call_id})
    assert (row.verdict, row.cost_micro_usd, row.user_id) == ("unsourced_figures", 231, SEED_USER)


def test_the_insert_deletes_calls_past_the_retention_window(migrated: Engine) -> None:
    with migrated.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO llm_calls (agent, provider, outcome, latency_ms, prompt, started_at) "
                "VALUES ('ask', 'openrouter', 'ok', 1, 'expired', now() - interval '31 days'), "
                "       ('ask', 'openrouter', 'ok', 1, 'kept', now() - interval '29 days')"
            )
        )
    call_id = DatabaseCallLog(migrated, retention_days=30).record(_entry("fresh"))
    with migrated.begin() as connection:
        prompts = set(
            connection.execute(
                text("SELECT prompt FROM llm_calls WHERE prompt IN ('expired', 'kept', 'fresh')")
            ).scalars()
        )
        connection.execute(
            text("DELETE FROM llm_calls WHERE prompt IN ('kept', 'fresh') OR id = :id"),
            {"id": call_id},
        )
    assert prompts == {"kept", "fresh"}
