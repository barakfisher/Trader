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


# 0041: `agent` becomes `purpose`, expand then contract. Until the contract, a pod
# still running the old code names `agent` and the new code names `purpose`; the
# trigger makes either insert carry both, so neither can break the other.


def test_an_old_writer_naming_agent_gets_purpose_too(migrated: Engine) -> None:
    with migrated.begin() as connection:
        row = connection.execute(
            text(
                "INSERT INTO llm_calls (agent, provider, outcome, latency_ms, prompt) "
                "VALUES ('ask', 'openrouter', 'ok', 1, 'old-writer') RETURNING agent, purpose"
            )
        ).one()
        connection.execute(text("DELETE FROM llm_calls WHERE prompt = 'old-writer'"))
    assert (row.agent, row.purpose) == ("ask", "ask")


def test_a_new_writer_naming_purpose_gets_agent_too(migrated: Engine) -> None:
    call_id = DatabaseCallLog(migrated, retention_days=30).record(_entry("new-writer"))
    with migrated.begin() as connection:
        row = connection.execute(
            text("SELECT agent, purpose FROM llm_calls WHERE id = :id"), {"id": call_id}
        ).one()
        connection.execute(text("DELETE FROM llm_calls WHERE id = :id"), {"id": call_id})
    assert (row.agent, row.purpose) == ("narration", "narration")


def test_agent_and_purpose_cannot_disagree(migrated: Engine) -> None:
    with migrated.connect() as connection:
        try:
            connection.execute(
                text(
                    "INSERT INTO llm_calls (agent, purpose, provider, outcome, latency_ms, prompt) "
                    "VALUES ('ask', 'narration', 'openrouter', 'ok', 1, 'disagree')"
                )
            )
        except Exception as error:  # noqa: BLE001 - the refusal is the assertion
            assert "llm_calls_purpose_is_agent" in str(error)
        else:
            raise AssertionError("a row whose agent and purpose disagree was accepted")
        finally:
            connection.rollback()


def test_an_agent_id_needs_its_user(migrated: Engine) -> None:
    with migrated.connect() as connection:
        agent_id = connection.execute(
            text("SELECT id::text FROM agents WHERE user_id = :user"), {"user": SEED_USER}
        ).scalar_one()
        try:
            connection.execute(
                text(
                    "INSERT INTO llm_calls (agent_id, purpose, provider, outcome, latency_ms, "
                    "prompt) VALUES (CAST(:agent AS uuid), 'ask', 'openrouter', 'ok', 1, 'orphan')"
                ),
                {"agent": agent_id},
            )
        except Exception as error:  # noqa: BLE001 - the refusal is the assertion
            assert "llm_calls_agent_has_user" in str(error)
        else:
            raise AssertionError("a call naming an agent but no user was accepted")
        finally:
            connection.rollback()
