"""The model a call uses: the one chosen on the Admin page for its purpose (D43).

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

from typing import Protocol

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.core.logging import get_logger
from app.llm.base import Caller, LLMCompletion, LLMProvider, Purpose, Verdict
from app.llm.catalogue import Scope

log = get_logger("llm.model_choice")

#: Which choice each purpose follows. Narration and `/ask` are both explanations
#: of figures the system computed, and share one model (D43).
SCOPE_FOR_PURPOSE: dict[Purpose, Scope] = {"narration": "explain", "ask": "explain"}


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
    """Passes each call the model chosen for its purpose."""

    def __init__(self, inner: LLMProvider, choices: ModelChoices) -> None:
        self._inner = inner
        self._choices = choices
        self.name = inner.name
        self.charges_per_token = inner.charges_per_token

    def _model_for(self, caller: Caller | None) -> str | None:
        if caller is None:
            return None
        scope = SCOPE_FOR_PURPOSE[caller.purpose]
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
            model=model or self._model_for(caller),
        )

    async def record_verdict(self, call_id: int | None, verdict: Verdict) -> None:
        await self._inner.record_verdict(call_id, verdict)
