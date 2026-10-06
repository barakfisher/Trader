"""The provider used when there is no model to call.

This exists so that "no LLM configured" is an ordinary, tested state rather than
a crash or a None that every call site has to remember to check. A fresh clone
has no API keys, CI has none by design, and Milestone 2's pipeline is required to
produce rule-based observations without narration - so the keyless path is the
one most often exercised, and it should be the least surprising.

It refuses by raising `LLMUnavailableError`, carrying the reason it was chosen.
Returning an empty string instead would have been the quiet option and the wrong
one: an empty narration flows downstream and reads as a model that had nothing to
say, when in fact nothing was ever asked.
"""

from __future__ import annotations

from collections.abc import Sequence

from app.core.logging import get_logger
from app.llm.base import (
    Caller,
    LLMCompletion,
    LLMUnavailableError,
    Message,
    ToolSpec,
    Verdict,
)

log = get_logger("llm.null")


class NullProvider:
    name = "null"
    #: Nothing is ever sent, so nothing is ever billed. The budget guard skips it.
    charges_per_token = False

    def __init__(self, reason: str = "no LLM provider is configured") -> None:
        self._reason = reason

    @property
    def reason(self) -> str:
        return self._reason

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
        # Logged on every refusal rather than once at startup: a run that quietly
        # produced no narration for a month is the outcome this line prevents.
        log.info("llm.unavailable", reason=self._reason)
        raise LLMUnavailableError(self._reason)

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
        log.info("llm.unavailable", reason=self._reason)
        raise LLMUnavailableError(self._reason)

    async def record_verdict(self, call_id: int | None, verdict: Verdict) -> None:
        """Nothing is recorded here; see `call_log.RecordingProvider`."""
