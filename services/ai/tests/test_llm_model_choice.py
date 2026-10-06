"""The model chosen on the Admin page reaches every call for its purpose (D43)."""

from __future__ import annotations

import pytest

from app.config import Settings
from app.llm.base import Caller, LLMCompletion, LLMUnavailableError, TokenUsage
from app.llm.call_log import CallEntry
from app.llm.factory import build_llm
from app.llm.model_choice import SCOPE_FOR_PURPOSE, ChoosingProvider


class Choices:
    def __init__(self, chosen: dict[str, str] | None = None, error: Exception | None = None):
        self._chosen = chosen or {}
        self._error = error
        self.asked: list[str] = []

    def chosen(self, scope):
        self.asked.append(scope)
        if self._error:
            raise self._error
        return self._chosen.get(scope)


class Inner:
    name = "stub"
    charges_per_token = True

    def __init__(self) -> None:
        self.models: list[str | None] = []

    async def complete(self, *, model=None, **_kwargs) -> LLMCompletion:
        self.models.append(model)
        return LLMCompletion(
            text="t",
            model=model or "configured",
            usage=TokenUsage(prompt_tokens=1, completion_tokens=1),
            estimated_cost_micro_usd=1,
            provider="stub",
        )

    async def record_verdict(self, call_id, verdict) -> None:
        return None


class MemoryLog:
    def __init__(self) -> None:
        self.entries: list[CallEntry] = []

    def record(self, entry: CallEntry) -> int:
        self.entries.append(entry)
        return len(self.entries)

    def set_verdict(self, call_id, verdict) -> None:
        return None


async def test_narration_and_ask_follow_the_explain_choice():
    inner, choices = Inner(), Choices({"explain": "anthropic/claude-sonnet-5.5"})
    provider = ChoosingProvider(inner, choices)
    for purpose in ("narration", "ask"):
        await provider.complete(system=None, user="u", caller=Caller(purpose=purpose))
    assert inner.models == ["anthropic/claude-sonnet-5.5"] * 2
    assert choices.asked == [SCOPE_FOR_PURPOSE["narration"], SCOPE_FOR_PURPOSE["ask"]]


async def test_nothing_chosen_leaves_the_configured_model():
    inner = Inner()
    await ChoosingProvider(inner, Choices()).complete(
        system=None, user="u", caller=Caller(purpose="ask")
    )
    assert inner.models == [None]


async def test_an_unreadable_choice_never_fails_the_call():
    inner = Inner()
    provider = ChoosingProvider(inner, Choices(error=RuntimeError("database down")))
    completion = await provider.complete(system=None, user="u", caller=Caller(purpose="ask"))
    assert inner.models == [None] and completion.text == "t"


def _settings(**overrides) -> Settings:
    return Settings(_env_file=None, app_env="test", **overrides)


async def test_the_recorded_model_is_the_chosen_one_even_when_no_model_answered():
    log = MemoryLog()
    llm = build_llm(
        _settings(llm_provider="openrouter", openrouter_api_key=None),
        call_log=log,
        choices=Choices({"explain": "anthropic/claude-sonnet-5.5"}),
    )
    with pytest.raises(LLMUnavailableError):
        await llm.complete(system=None, user="q", caller=Caller(purpose="narration"))
    [entry] = log.entries
    assert (entry.purpose, entry.model) == ("narration", "anthropic/claude-sonnet-5.5")


def test_a_choice_applies_only_to_openrouter():
    choices = Choices({"explain": "anthropic/claude-sonnet-5.5"})
    assert isinstance(
        build_llm(_settings(llm_provider="openrouter"), choices=choices), ChoosingProvider
    )
    assert not isinstance(
        build_llm(_settings(llm_provider="ollama"), choices=choices), ChoosingProvider
    )
