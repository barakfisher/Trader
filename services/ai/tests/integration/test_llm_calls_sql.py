"""`DatabaseCallLog` against a real Postgres: a call and its verdict are one row,
and the insert itself deletes whatever has outlived the retention window."""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.llm.call_log import CallEntry, DatabaseCallLog

SEED_USER = "00000000-0000-0000-0000-000000000001"


def _entry(prompt: str) -> CallEntry:
    return CallEntry(
        purpose="narration",
        user_id=SEED_USER,
        agent_id=None,
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
                "INSERT INTO llm_calls (purpose, provider, outcome, latency_ms, prompt, started_at) "
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


# 0042: only an agent's scan names an agent, and it always does - so an agent's
# spend (D45) is one purpose's sum, and no scan's call can lose its agent.


def _refused(migrated: Engine, sql: str, params: dict, constraint: str) -> None:
    with migrated.connect() as connection:
        try:
            connection.execute(text(sql), params)
        except Exception as error:  # noqa: BLE001 - the refusal is the assertion
            assert constraint in str(error)
        else:
            raise AssertionError(f"{constraint} did not refuse the row")
        finally:
            connection.rollback()


def _simulated_agent(migrated: Engine) -> str:
    with migrated.begin() as connection:
        return connection.execute(
            text(
                "INSERT INTO agents (user_id, slug, name, budget_minor) "
                "VALUES (:user, 'scan-calls', 'Scan calls', 100000) RETURNING id::text"
            ),
            {"user": SEED_USER},
        ).scalar_one()


def test_a_scan_call_must_name_its_agent_and_nothing_else_may(migrated: Engine) -> None:
    agent = _simulated_agent(migrated)
    insert = (
        "INSERT INTO llm_calls (user_id, agent_id, purpose, provider, outcome, latency_ms, prompt) "
        "VALUES (:user, CAST(:agent AS uuid), :purpose, 'openrouter', 'ok', 1, 'p')"
    )
    _refused(
        migrated,
        insert,
        {"user": SEED_USER, "agent": None, "purpose": "agent_scan"},
        "llm_calls_scan_names_its_agent",
    )
    _refused(
        migrated,
        insert,
        {"user": SEED_USER, "agent": agent, "purpose": "narration"},
        "llm_calls_scan_names_its_agent",
    )
    with migrated.begin() as connection:
        connection.execute(text(insert), {"user": SEED_USER, "agent": agent, "purpose": "agent_scan"})
        connection.execute(text("DELETE FROM llm_calls WHERE agent_id = CAST(:a AS uuid)"), {"a": agent})
        connection.execute(text("DELETE FROM agents WHERE id = CAST(:a AS uuid)"), {"a": agent})


def test_an_agent_id_needs_its_user(migrated: Engine) -> None:
    with migrated.connect() as connection:
        agent_id = connection.execute(
            text("SELECT id::text FROM agents WHERE user_id = :user"), {"user": SEED_USER}
        ).scalar_one()
        try:
            connection.execute(
                text(
                    "INSERT INTO llm_calls (agent_id, purpose, provider, outcome, latency_ms, "
                    "prompt) VALUES (CAST(:agent AS uuid), 'agent_scan', 'openrouter', 'ok', 1, "
                    "'orphan')"
                ),
                {"agent": agent_id},
            )
        except Exception as error:  # noqa: BLE001 - the refusal is the assertion
            assert "llm_calls_agent_has_user" in str(error)
        else:
            raise AssertionError("a call naming an agent but no user was accepted")
        finally:
            connection.rollback()
