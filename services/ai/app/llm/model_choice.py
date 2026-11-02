"""The model a call uses: the one its user chose for it (D244, D360).

Every user - the admin included since D360 - runs on what they chose for the
agent, for Ask or for explanations, resolved against OpenRouter's list
(`user_models.py`, D283-D284); nothing chosen runs on the tested model. The
Admin page's installation-wide choice (`llm_model_choices`, D43) is gone with
its table (migration 0081).

A call for no user, or with models not choosable (another provider than
OpenRouter), is passed no model and runs on the configured one (`LLM_MODEL`).

A failed read never fails the call. It is logged, and the tested model answers
- the same rule the recorder follows (`call_log.py`): the machinery around a
call must not be what stops it.

`ChoosingProvider` sits outermost in the chain (`factory.py`), above the
recorder, so the model it chose is the one recorded even for a call refused
before any reply named a model.
"""

from __future__ import annotations

from collections.abc import Sequence

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
    # D254: research is the assigned agent's own call, on its model.
    "research": "agent",
    "assistant": "assistant",
}


class ChoosingProvider:
    """Passes each call the model its user chose for its purpose."""

    def __init__(
        self, inner: LLMProvider, *, users: UserModelStore, listed: OpenRouterModels
    ) -> None:
        self._inner = inner
        self._users = users
        self._listed = listed
        self.name = inner.name
        self.charges_per_token = inner.charges_per_token

    async def _model_for(self, caller: Caller | None) -> str | None:
        if caller is None or caller.user_id is None:
            return None
        scope = SCOPE_FOR_PURPOSE[caller.purpose]
        try:
            choice = self._users.choice(caller.user_id, scope, caller.agent_id)
        except Exception as error:  # noqa: BLE001 - never fail the caller
            log.warning("llm.user_model_unreadable", scope=scope, error=str(error))
            return FALLBACK_MODEL
        if choice is None:
            # No such user: nothing chosen, so the tested model.
            return FALLBACK_MODEL
        resolution = resolve(choice.saved, await self._listed.current(), self._listed.prices)
        if resolution.fallback:
            try:
                self._users.record_fallback(caller.user_id, scope, caller.agent_id, resolution)
            except Exception as error:  # noqa: BLE001 - never fail the caller
                log.warning("llm.model_fallback_unrecorded", scope=scope, error=str(error))
        return resolution.effective

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
