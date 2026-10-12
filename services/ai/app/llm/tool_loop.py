"""The tool-calling loop an agent's scan and the assistant share (D15, D53).

Each turn sends the conversation so far; the model either asks for tools, which
run and are appended as results, or answers in text, and the loop returns that
answer for the caller to judge. Judging is the caller's: a scan checks a trade,
the assistant checks prose, and either may append a correction and call again
with the same state.

Plain Python and short on purpose (decided 2026-10-07: no agent framework). The
limits are the code's, whatever the model does:

- **The caller's budget** is asked before every model call, not once per loop,
  so a costly model is stopped where it crosses the line; the installation-wide
  guard refuses a call on its own as well. Either ends the loop as
  `budget_reached`.
- **The step limit**: at most `step_limit` tool calls. When it is reached the
  next turn offers no tools, so the model must answer with what it has; a model
  that still asks for tools ends the loop as `step_limit`.

Every tool call the model makes gets a result in the conversation, even past
the limit, because a provider rejects a conversation with an unanswered call.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from app.llm.base import (
    AssistantMessage,
    Caller,
    LLMBudgetExceededError,
    LLMCompletion,
    LLMError,
    LLMProvider,
    Message,
    ToolResultMessage,
    ToolSpec,
)

#: How a loop ended. `answer` carries the model's text reply; the rest carry none.
LoopEnd = Literal["answer", "step_limit", "budget_reached", "failed"]

STEP_LIMIT_RESULT = json.dumps(
    {"error": "the step limit is reached; answer now with what you have"}
)

#: Runs one tool call - a name and the arguments as the model wrote them - and
#: answers the JSON text the model will read.
ToolRunner = Callable[[str, str], Awaitable[str]]


@dataclass
class LoopState:
    """The conversation and what it has cost, kept across calls to `run_tool_loop`."""

    messages: list[Message]
    steps: int = 0
    cost_micro_usd: int = 0
    model: str | None = None
    #: Each assistant turn and tool result, in order: what is stored for review.
    transcript: list[dict[str, Any]] = field(default_factory=list)
    #: Every tool result the model saw, parsed: the evidence its figures are checked against.
    tool_results: list[Any] = field(default_factory=list)


@dataclass(frozen=True)
class LoopStop:
    end: LoopEnd
    reply: LLMCompletion | None = None
    error: str | None = None
    #: The model error that ended the loop, so a caller can tell "no model is
    #: configured" (`LLMUnavailableError`) from a call that failed.
    cause: LLMError | None = None


async def run_tool_loop(
    state: LoopState,
    *,
    llm: LLMProvider,
    system: str,
    tools: Sequence[ToolSpec],
    run_tool: ToolRunner,
    step_limit: int,
    max_output_tokens: int,
    caller: Caller,
    within_budget: Callable[[], bool],
) -> LoopStop:
    """Converse until the model answers in text or a limit ends it. Fills `state` as
    it goes, so a caller's timeout keeps what was done."""
    while True:
        if not within_budget():
            return LoopStop("budget_reached")
        offer_tools = state.steps < step_limit
        try:
            reply = await llm.converse(
                system=system,
                messages=state.messages,
                tools=list(tools) if offer_tools else [],
                max_output_tokens=max_output_tokens,
                caller=caller,
            )
        except LLMBudgetExceededError as error:
            return LoopStop("budget_reached", error=str(error), cause=error)
        except LLMError as error:
            return LoopStop("failed", error=f"{type(error).__name__}: {error}", cause=error)

        state.cost_micro_usd += reply.estimated_cost_micro_usd
        state.model = reply.model
        state.messages.append(AssistantMessage(reply.text, reply.tool_calls))
        state.transcript.append(
            {
                "role": "assistant",
                "text": reply.text,
                "tool_calls": [
                    {"id": c.id, "name": c.name, "arguments": c.arguments} for c in reply.tool_calls
                ],
            }
        )

        if not reply.tool_calls:
            return LoopStop("answer", reply=reply)
        if not offer_tools:
            return LoopStop("step_limit")

        for call in reply.tool_calls:
            if state.steps >= step_limit:
                content = STEP_LIMIT_RESULT
            else:
                state.steps += 1
                content = await run_tool(call.name, call.arguments)
                state.tool_results.append(json.loads(content))
            state.messages.append(ToolResultMessage(call.id, content))
            state.transcript.append(
                {
                    "role": "tool",
                    "call_id": call.id,
                    "name": call.name,
                    "result": json.loads(content),
                }
            )
