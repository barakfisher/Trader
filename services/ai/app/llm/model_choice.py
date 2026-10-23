"""The model a call uses: the user's own choice (D244), or the Admin page's for its purpose (D43).

**A user who is not the admin** runs on what they chose for the agent, for Ask
or for explanations, resolved against OpenRouter's list (`user_models.py`,
D283-D284) - never on the admin's choice. Everything below is about the admin,
and about calls for no user, which keep `llm_model_choices`.

`llm_model_choices` holds one model per scope (migration 0041), written by the
orchestrator's admin route and read here on every call, so a choice takes
effect on the next call without a redeploy. No row means nothing has been
chosen, and the provider's configured model (`LLM_MODEL`) answers, as it did
before the table existed.

Read per call rather than cached: calls are seconds apart at the busiest and the
read is one primary-key lookup, while a cache would make "I changed the model"
true on one pod and not another for as long as it lived.

A failed read never fails the call. It is logged, and the configured model
answers - the same rule the recorder follows (`call_log.py`): the machinery
around a call must not be what stops it.

`ChoosingProvider` sits outermost in the chain (`factory.py`), above the
recorder, so the model it chose is the one recorded even for a call refused
before any reply named a model.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.core.logging import get_logger
from app.llm.base import Caller, LLMCompletion, LLMProvider, Message, Purpose, ToolSpec, Verdict
from app.llm.catalogue import FALLBACK_MODEL, Scope
from app.llm.openrouter_models import OpenRouterModels
from app.llm.user_models import UserModelStore, resolve

log = get_logger("llm.model_choice")

#: Which choice each purpose follows. Narration and `/ask` are both explanations
#: of figures the system computed, and share one model (D43).
SCOPE_FOR_PURPOSE: dict[Purpose, Scope] = {
    "narration": "explain",
    "ask": "explain",
    "agent_scan": "agent",
    # D177: an agent's own call, on the model chosen for agents.
    "mandate_check": "agent",
    "assistant": "assistant",
}


class ModelChoices(Protocol):
    def chosen(self, scope: Scope) -> str | None:
        """The model chosen for `scope`, or None when none has been. May raise."""
        ...


class DatabaseModelChoices:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def chosen(self, scope: Scope) -> str | None:
        with self._engine.connect() as connection:
            return connection.execute(
                text("SELECT model FROM llm_model_choices WHERE scope = :scope"),
                {"scope": scope},
            ).scalar_one_or_none()

    def all(self) -> dict[Scope, str]:
        with self._engine.connect() as connection:
            rows = connection.execute(text("SELECT scope, model FROM llm_model_choices")).all()
        return {row.scope: row.model for row in rows}


class ChoosingProvider:
    """Passes each call the model chosen for its purpose: the user's, or the admin's."""

    def __init__(
        self,
        inner: LLMProvider,
        choices: ModelChoices,
        *,
        users: UserModelStore | None = None,
        listed: OpenRouterModels | None = None,
    ) -> None:
        self._inner = inner
        self._choices = choices
        self._users = users
        self._listed = listed
        self.name = inner.name
        self.charges_per_token = inner.charges_per_token

    async def _model_for(self, caller: Caller | None) -> str | None:
        if caller is None:
            return None
        scope = SCOPE_FOR_PURPOSE[caller.purpose]
        if caller.user_id is not None and self._users is not None and self._listed is not None:
            try:
                choice = self._users.choice(caller.user_id, scope, caller.agent_id)
            except Exception as error:  # noqa: BLE001 - never fail the caller
                # Unknown whether this is the admin: the tested model is the
                # cheap answer, and never a stranger's call on the admin's pick.
                log.warning("llm.user_model_unreadable", scope=scope, error=str(error))
                return FALLBACK_MODEL
            if choice is not None and not choice.admin:
                resolution = resolve(
                    choice.saved, await self._listed.current(), self._listed.prices
                )
                if resolution.fallback:
                    try:
                        self._users.record_fallback(
                            caller.user_id, scope, caller.agent_id, resolution
                        )
                    except Exception as error:  # noqa: BLE001 - never fail the caller
                        log.warning("llm.model_fallback_unrecorded", scope=scope, error=str(error))
                return resolution.effective
        try:
            return self._choices.chosen(scope)
        except Exception as error:  # noqa: BLE001 - never fail the caller
            log.warning("llm.model_choice_unreadable", scope=scope, error=str(error))
            return None

    async def complete(
        self,
        *,
        system: str | None,
        user: str,
        max_output_tokens: int | None = None,
        temperature: float | None = None,
        reasoning_effort: str | None = None,
        caller: Caller | None = None,
        model: str | None = None,
    ) -> LLMCompletion:
        return await self._inner.complete(
            system=system,
            user=user,
            max_output_tokens=max_output_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            caller=caller,
            model=model or await self._model_for(caller),
        )

    async def converse(
        self,
        *,
        system: str,
        messages: Sequence[Message],
        tools: Sequence[ToolSpec],
        max_output_tokens: int | None = None,
        temperature: float | None = None,
        reasoning_effort: str | None = None,
        caller: Caller | None = None,
        model: str | None = None,
    ) -> LLMCompletion:
        return await self._inner.converse(
            system=system,
            messages=messages,
            tools=tools,
            max_output_tokens=max_output_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            caller=caller,
            model=model or await self._model_for(caller),
        )

    async def record_verdict(self, call_id: int | None, verdict: Verdict) -> None:
        await self._inner.record_verdict(call_id, verdict)
