"""Every model call, recorded by a wrapper the factory puts around the provider.

The admin page's question is "which agent is slow, costly or failing, and
why?" (M8). It can only be answered from every call - including the ones that
never reached a model because none was configured or the day's budget was
spent - so recording is not something a call site does. The factory wraps
whatever it builds in `RecordingProvider`, outermost, and a call site that asks
for a completion has been recorded by the time it gets one (decision 87).

What only the call site knows is whether it could *use* the text: parsed,
sourced, not a loop. It reports that with `record_verdict(call_id, ...)` on the
same provider it asked, and the wrapper adds it to the call's row.

Recording never fails a call. A row that could not be written is logged and
the completion is returned exactly as it would have been: observability that
can take down narration is the wrong way round.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace
from typing import Literal, Protocol

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.core.logging import get_logger
from app.llm.base import (
    AssistantMessage,
    Caller,
    LLMBudgetExceededError,
    LLMCompletion,
    LLMError,
    LLMProvider,
    LLMUnavailableError,
    Message,
    ToolResultMessage,
    ToolSpec,
    UserMessage,
    Verdict,
)

log = get_logger("llm.call_log")

Outcome = Literal["ok", "provider_error", "budget_exhausted", "no_provider"]


@dataclass(frozen=True)
class CallEntry:
    purpose: str
    user_id: str | None
    agent_id: str | None
    provider: str
    model: str | None
    outcome: Outcome
    error: str | None
    latency_ms: int
    prompt_tokens: int
    completion_tokens: int
    cost_micro_usd: int
    prompt: str
    completion: str | None


class CallLog(Protocol):
    def record(self, entry: CallEntry) -> int:
        """Store one call and return its id. May raise."""
        ...

    def set_verdict(self, call_id: int, verdict: Verdict) -> None:
        """Add the caller's verdict to a stored call. May raise."""
        ...


class DatabaseCallLog:
    """`llm_calls`, pruned of rows past the retention window on every insert.

    Pruning here rather than in a scheduled job: a job is one more thing that
    must exist in compose, in the cluster and in `scheduler.ts`, and the table
    grows only when calls are made - so the insert is exactly when it is due.
    At the measured volume (about 45 calls a week) the delete is nothing.
    """

    def __init__(self, engine: Engine, retention_days: int) -> None:
        self._engine = engine
        self._retention_days = retention_days

    def record(self, entry: CallEntry) -> int:
        with self._engine.begin() as connection:
            connection.execute(
                text(
                    "DELETE FROM llm_calls WHERE started_at < now() - make_interval(days => :days)"
                ),
                {"days": self._retention_days},
            )
            return int(
                connection.execute(
                    text(
                        """
                        INSERT INTO llm_calls (
                            user_id, agent_id, purpose, provider, model, outcome, error,
                            latency_ms, prompt_tokens, completion_tokens, cost_micro_usd, prompt,
                            completion
                        ) VALUES (
                            CAST(:user_id AS uuid), CAST(:agent_id AS uuid), :purpose, :provider,
                            :model, :outcome, :error,
                            :latency_ms, :prompt_tokens, :completion_tokens, :cost_micro_usd,
                            :prompt, :completion
                        )
                        RETURNING id
                        """
                    ),
                    {
                        "user_id": entry.user_id,
                        "agent_id": entry.agent_id,
                        "purpose": entry.purpose,
                        "provider": entry.provider,
                        "model": entry.model,
                        "outcome": entry.outcome,
                        "error": entry.error,
                        "latency_ms": entry.latency_ms,
                        "prompt_tokens": entry.prompt_tokens,
                        "completion_tokens": entry.completion_tokens,
                        "cost_micro_usd": entry.cost_micro_usd,
                        "prompt": entry.prompt,
                        "completion": entry.completion,
                    },
                ).scalar_one()
            )

    def set_verdict(self, call_id: int, verdict: Verdict) -> None:
        with self._engine.begin() as connection:
            connection.execute(
                text("UPDATE llm_calls SET verdict = :verdict WHERE id = :id"),
                {"id": call_id, "verdict": verdict},
            )


def _outcome(error: BaseException) -> Outcome:
    if isinstance(error, LLMUnavailableError):
        return "no_provider"
    if isinstance(error, LLMBudgetExceededError):
        return "budget_exhausted"
    return "provider_error"


def _prompt(system: str | None, user: str) -> str:
    return f"[system]\n{system}\n\n[user]\n{user}" if system else f"[user]\n{user}"


def _render(message: Message) -> str:
    if isinstance(message, UserMessage):
        return f"[user]\n{message.text}"
    if isinstance(message, AssistantMessage):
        calls = "".join(f"\n-> {call.name}({call.arguments})" for call in message.tool_calls)
        return f"[assistant]\n{message.text}{calls}"
    if isinstance(message, ToolResultMessage):
        return f"[tool {message.call_id}]\n{message.content}"
    return repr(message)


def _conversation_prompt(system: str, messages: Sequence[Message]) -> str:
    """What this turn added: the whole opening, then only what followed the model's last turn.

    Every turn re-sends the conversation, and storing each turn's full prompt
    would keep a scan's briefing twelve times over. The scan's own transcript
    (D50) holds the conversation once; a row here holds what is new in it.
    """
    last_assistant = max(
        (index for index, message in enumerate(messages) if isinstance(message, AssistantMessage)),
        default=None,
    )
    if last_assistant is None:
        return "\n\n".join([f"[system]\n{system}", *(_render(m) for m in messages)])
    tail = messages[last_assistant + 1 :]
    return "\n\n".join([f"[{last_assistant + 1} earlier messages]", *(_render(m) for m in tail)])


def _completion_text(completion: LLMCompletion) -> str:
    calls = "".join(f"\n-> {call.name}({call.arguments})" for call in completion.tool_calls)
    return f"{completion.text}{calls}"


class RecordingProvider:
    """Records every call to `inner`, whatever becomes of it."""

    def __init__(self, inner: LLMProvider, call_log: CallLog, model: str | None) -> None:
        self._inner = inner
        self._log = call_log
        #: The configured model, for a call that failed before any reply named one.
        self._model = model
        self.name = inner.name
        self.charges_per_token = inner.charges_per_token

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
        return await self._recorded(
            lambda: self._inner.complete(
                system=system,
                user=user,
                max_output_tokens=max_output_tokens,
                temperature=temperature,
                reasoning_effort=reasoning_effort,
                caller=caller,
                model=model,
            ),
            caller=caller,
            model=model,
            prompt=_prompt(system, user),
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
        return await self._recorded(
            lambda: self._inner.converse(
                system=system,
                messages=messages,
                tools=tools,
                max_output_tokens=max_output_tokens,
                temperature=temperature,
                reasoning_effort=reasoning_effort,
                caller=caller,
                model=model,
            ),
            caller=caller,
            model=model,
            prompt=_conversation_prompt(system, messages),
        )

    async def _recorded(
        self,
        call: Callable[[], Awaitable[LLMCompletion]],
        *,
        caller: Caller | None,
        model: str | None,
        prompt: str,
    ) -> LLMCompletion:
        started = time.monotonic()
        try:
            completion = await call()
        except BaseException as error:
            self._record(
                caller,
                model=model,
                outcome=_outcome(error),
                error=f"{type(error).__name__}: {error}"[:500],
                started=started,
                prompt=prompt,
                cost=error.metered_micro_usd if isinstance(error, LLMError) else 0,
            )
            raise
        call_id = self._record(
            caller,
            model=model,
            outcome="ok",
            started=started,
            prompt=prompt,
            completion=completion,
        )
        return replace(completion, call_id=call_id)

    async def record_verdict(self, call_id: int | None, verdict: Verdict) -> None:
        if call_id is None:
            return
        try:
            self._log.set_verdict(call_id, verdict)
        except Exception as error:  # noqa: BLE001 - never fail the caller
            log.warning("llm.verdict_not_recorded", call_id=call_id, error=str(error))

    def _record(
        self,
        caller: Caller | None,
        *,
        model: str | None,
        outcome: Outcome,
        started: float,
        prompt: str,
        completion: LLMCompletion | None = None,
        error: str | None = None,
        cost: int = 0,
    ) -> int | None:
        if caller is None:
            # Every call site names itself; one that does not is a bug worth a
            # log line, not a row with a guessed purpose.
            log.error("llm.call_without_caller", provider=self.name)
            return None
        entry = CallEntry(
            purpose=caller.purpose,
            user_id=caller.user_id,
            agent_id=caller.agent_id,
            provider=completion.provider if completion else self.name,
            model=completion.model if completion else (model or self._model),
            outcome=outcome,
            error=error,
            latency_ms=max(0, round((time.monotonic() - started) * 1000)),
            prompt_tokens=completion.usage.prompt_tokens if completion else 0,
            completion_tokens=completion.usage.completion_tokens if completion else 0,
            cost_micro_usd=completion.estimated_cost_micro_usd if completion else cost,
            prompt=prompt,
            completion=_completion_text(completion) if completion else None,
        )
        try:
            return self._log.record(entry)
        except Exception as error:  # noqa: BLE001 - never fail the caller
            log.warning("llm.call_not_recorded", purpose=entry.purpose, error=str(error))
            return None
