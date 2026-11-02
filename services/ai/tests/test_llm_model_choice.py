"""The model a user chose reaches every call of theirs for its purpose (D244, D360)."""

from __future__ import annotations

import pytest

from app.config import Settings
from app.llm.base import Caller, LLMCompletion, LLMUnavailableError, TokenUsage
from app.llm.call_log import CallEntry
from app.llm.catalogue import FALLBACK_MODEL
from app.llm.factory import build_llm
from app.llm.model_choice import SCOPE_FOR_PURPOSE, ChoosingProvider
from app.llm.openrouter_models import ListedModel, ModelList
from app.llm.pricing import DEFAULT_MODEL_PRICES, ModelPrice
from app.llm.user_models import ModelResolution, UserModelChoice

CHOSEN = "anthropic/claude-sonnet-5.5"
TESTED = ListedModel(
    id=FALLBACK_MODEL, name="Flash-Lite", price=DEFAULT_MODEL_PRICES[FALLBACK_MODEL]
)


class Users:
    def __init__(self, choice: UserModelChoice | None, error: Exception | None = None):
        self._choice = choice
        self._error = error
        self.asked: list[tuple[str, str, str | None]] = []
        self.recorded: list[tuple[str, str, str | None, ModelResolution]] = []

    def choice(self, user_id, scope, agent_id):
        self.asked.append((user_id, scope, agent_id))
        if self._error:
            raise self._error
        return self._choice

    def record_fallback(self, user_id, scope, agent_id, resolution):
        self.recorded.append((user_id, scope, agent_id, resolution))


class Listed:
    def __init__(self, models: ModelList) -> None:
        self._models = models

    async def current(self) -> ModelList:
        return self._models

    @property
    def prices(self) -> dict[str, ModelPrice]:
        return DEFAULT_MODEL_PRICES


def listing(*models: ListedModel, live: bool = True) -> ModelList:
    return ModelList(models=models, live=live)


ON_THE_LIST = listing(
    ListedModel(id=CHOSEN, name=CHOSEN, price=DEFAULT_MODEL_PRICES[CHOSEN]), TESTED
)


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


async def test_narration_and_ask_follow_the_users_explain_choice():
    inner, users = Inner(), Users(UserModelChoice(saved=CHOSEN))
    provider = ChoosingProvider(inner, users=users, listed=Listed(ON_THE_LIST))
    for purpose in ("narration", "ask"):
        await provider.complete(system=None, user="u", caller=Caller(purpose, user_id="u1"))
    assert inner.models == [CHOSEN] * 2
    assert [scope for _, scope, _ in users.asked] == [
        SCOPE_FOR_PURPOSE["narration"],
        SCOPE_FOR_PURPOSE["ask"],
    ]


async def test_a_call_for_no_user_runs_on_the_configured_model():
    inner, users = Inner(), Users(UserModelChoice(saved=CHOSEN))
    provider = ChoosingProvider(inner, users=users, listed=Listed(ON_THE_LIST))
    await provider.complete(system=None, user="u", caller=Caller(purpose="ask"))
    await provider.complete(system=None, user="u")
    assert inner.models == [None, None] and users.asked == []


async def test_an_unreadable_choice_never_fails_the_call():
    inner = Inner()
    users = Users(None, error=RuntimeError("database down"))
    provider = ChoosingProvider(inner, users=users, listed=Listed(ON_THE_LIST))
    completion = await provider.complete(
        system=None, user="u", caller=Caller(purpose="ask", user_id="u1")
    )
    assert inner.models == [FALLBACK_MODEL] and completion.text == "t"


def _settings(**overrides) -> Settings:
    return Settings(_env_file=None, app_env="test", **overrides)


async def test_the_recorded_model_is_the_chosen_one_even_when_no_model_answered():
    log = MemoryLog()
    llm = build_llm(
        _settings(llm_provider="openrouter", openrouter_api_key=None),
        call_log=log,
        users=Users(UserModelChoice(saved=CHOSEN)),
        listed=Listed(ON_THE_LIST),
    )
    with pytest.raises(LLMUnavailableError):
        await llm.complete(system=None, user="q", caller=Caller("narration", user_id="u1"))
    [entry] = log.entries
    assert (entry.purpose, entry.model) == ("narration", CHOSEN)


def test_a_choice_applies_only_to_openrouter():
    users, listed = Users(UserModelChoice(saved=CHOSEN)), Listed(ON_THE_LIST)
    assert isinstance(
        build_llm(_settings(llm_provider="openrouter"), users=users, listed=listed),
        ChoosingProvider,
    )
    assert not isinstance(
        build_llm(_settings(llm_provider="ollama"), users=users, listed=listed), ChoosingProvider
    )
