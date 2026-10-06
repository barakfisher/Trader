"""Every model call is recorded by the wrapper the factory builds (decision 87).

The call sites never log; they only add a verdict. So what is pinned here is
that the wrapper records every outcome - including calls that never reached a
model - and that recording can never change what the caller gets back.
"""

from __future__ import annotations

import typing
from pathlib import Path

import pytest

from app.llm import call_log as call_log_module
from app.llm.base import (
    Caller,
    LLMBudgetExceededError,
    LLMCompletion,
    LLMRequestError,
    LLMUnavailableError,
    Purpose,
    TokenUsage,
    Verdict,
)
from app.llm.call_log import CallEntry, Outcome, RecordingProvider
from app.llm.catalogue import Scope
from app.llm.factory import build_llm

VERSIONS = Path(__file__).parents[1] / "alembic" / "versions"
MIGRATION = VERSIONS / "0029_llm_calls.py"
PURPOSE_MIGRATION = VERSIONS / "0042_agent_scan_inputs.py"
SCOPE_MIGRATION = VERSIONS / "0041_llm_models.py"


class MemoryLog:
    def __init__(self, *, fail: bool = False) -> None:
        self.entries: list[CallEntry] = []
        self.verdicts: dict[int, str] = {}
        self._fail = fail

    def record(self, entry: CallEntry) -> int:
        if self._fail:
            raise ConnectionError("database is down")
        self.entries.append(entry)
        return len(self.entries)

    def set_verdict(self, call_id: int, verdict: Verdict) -> None:
        if self._fail:
            raise ConnectionError("database is down")
        self.verdicts[call_id] = verdict


class Provider:
    name = "stub"
    charges_per_token = True

    def __init__(self, error: Exception | None = None) -> None:
        self._error = error

    async def complete(self, **_kwargs: object) -> LLMCompletion:
        if self._error:
            raise self._error
        return LLMCompletion(
            text='{"headline": "h", "explanation": "e"}',
            model="stub-model-2026",
            usage=TokenUsage(prompt_tokens=120, completion_tokens=40),
            estimated_cost_micro_usd=231,
            provider="stub",
        )

    async def record_verdict(self, call_id: int | None, verdict: Verdict) -> None:
        return None


CALLER = Caller(purpose="narration", user_id="00000000-0000-0000-0000-000000000001")


async def _call(provider: RecordingProvider, caller: Caller | None = CALLER) -> LLMCompletion:
    return await provider.complete(system="rules", user="evidence", caller=caller)


async def test_a_completed_call_is_recorded_whole_and_handed_back_with_its_id() -> None:
    log = MemoryLog()
    completion = await _call(RecordingProvider(Provider(), log, model="configured"))
    assert completion.call_id == 1
    [entry] = log.entries
    assert entry.purpose == "narration"
    assert entry.user_id == CALLER.user_id
    assert (entry.provider, entry.model, entry.outcome) == ("stub", "stub-model-2026", "ok")
    assert (entry.prompt_tokens, entry.completion_tokens, entry.cost_micro_usd) == (120, 40, 231)
    assert entry.prompt == "[system]\nrules\n\n[user]\nevidence"
    assert entry.completion == completion.text
    assert entry.latency_ms >= 0 and entry.error is None


@pytest.mark.parametrize(
    ("error", "outcome", "cost"),
    [
        (LLMUnavailableError("no LLM provider is configured"), "no_provider", 0),
        (LLMBudgetExceededError(5_000_000, 5_000_000, "2026-10-01"), "budget_exhausted", 0),
        # An answer that arrived and could not be used still burned tokens.
        (LLMRequestError("stub", "unparseable", metered_micro_usd=88), "provider_error", 88),
    ],
)
async def test_a_call_that_failed_is_recorded_and_the_failure_still_reaches_the_caller(
    error: Exception, outcome: str, cost: int
) -> None:
    log = MemoryLog()
    with pytest.raises(type(error)):
        await _call(RecordingProvider(Provider(error), log, model="configured"))
    [entry] = log.entries
    assert (entry.outcome, entry.cost_micro_usd, entry.model) == (outcome, cost, "configured")
    assert entry.completion is None and entry.error is not None


async def test_recording_that_fails_changes_nothing_for_the_caller() -> None:
    log = MemoryLog(fail=True)
    provider = RecordingProvider(Provider(), log, model="configured")
    completion = await _call(provider)
    assert completion.text.startswith("{")
    assert completion.call_id is None
    await provider.record_verdict(1, "accepted")  # swallowed, not raised


async def test_the_caller_verdict_lands_on_the_call_it_judged() -> None:
    log = MemoryLog()
    provider = RecordingProvider(Provider(), log, model="configured")
    completion = await _call(provider)
    await provider.record_verdict(completion.call_id, "unsourced_figures")
    await provider.record_verdict(None, "accepted")  # nothing recorded, nothing to judge
    assert log.verdicts == {1: "unsourced_figures"}


async def test_a_call_that_does_not_name_its_agent_is_not_given_a_guessed_one() -> None:
    log = MemoryLog()
    completion = await _call(RecordingProvider(Provider(), log, model="configured"), caller=None)
    assert log.entries == [] and completion.call_id is None


async def test_the_factory_records_even_a_call_no_model_could_take(settings) -> None:
    log = MemoryLog()
    llm = build_llm(settings.model_copy(update={"llm_provider": "null"}), call_log=log)
    with pytest.raises(LLMUnavailableError):
        await llm.complete(system=None, user="q", caller=Caller(purpose="ask"))
    [entry] = log.entries
    assert (entry.purpose, entry.outcome, entry.model, entry.provider) == (
        "ask",
        "no_provider",
        None,
        "null",
    )


def _migration(path: Path):
    import importlib.util

    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_the_database_accepts_exactly_the_values_the_code_can_write() -> None:
    """The CHECKs in 0029, 0041 and 0042 and the Literals in code are one list each, twice."""
    migration = _migration(MIGRATION)
    assert set(_migration(PURPOSE_MIGRATION).PURPOSES) == set(typing.get_args(Purpose))
    assert set(_migration(SCOPE_MIGRATION).SCOPES) == set(typing.get_args(Scope))
    assert set(migration.OUTCOMES) == set(typing.get_args(Outcome))
    assert set(migration.VERDICTS) == set(typing.get_args(Verdict))
    assert call_log_module.RecordingProvider is RecordingProvider
