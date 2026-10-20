"""One question to the assistant: the conversation so far in, a checked reply out.

1. The question is stored first, so it is kept even when no reply can be.
2. The conversation's last `HISTORY_MESSAGES` messages are sent with it - the
   user's words and the assistant's replies as the user saw them. Earlier tool
   results are not re-sent (they would be paid for again on every question),
   but they stay evidence: a follow-up that repeats a figure from an earlier
   answer is checked against the tool result that answer came from.
3. The shared loop (`app/llm/tool_loop.py`) runs the model with the
   assistant's tools under the step limit and the user's daily budget.
4. The reply is checked (`reply.py`). One that fails is sent back once with
   what was wrong; one that fails again is not shown - the user is told no
   checked answer could be given, and the transcript is kept for review.

Nothing here writes anything but the conversation's own rows and the
recorder's `llm_calls`.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from sqlalchemy.engine import Engine

from app.agents.tools import ToolContext
from app.agents.tools import run_tool as run_any_tool
from app.assistant import conversations
from app.assistant.budget import assistant_budget
from app.assistant.instructions import instructions
from app.assistant.reply import Checked, check, sources
from app.assistant.tools import TOOLS, TOOLS_BY_NAME
from app.core.logging import get_logger
from app.llm.base import (
    AssistantMessage,
    Caller,
    LLMProvider,
    LLMUnavailableError,
    Message,
    MonthlyCapReachedError,
    UserMessage,
)
from app.llm.tool_loop import LoopState, run_tool_loop

log = get_logger("assistant.service")

#: Tool calls per question. Most need one to three; a comparison or a "what
#: happened while I was away" needs more.
STEP_LIMIT = 8
#: Output tokens per model turn: a tool request, or a reply of a few paragraphs.
#: 1,500 cut a real reply off mid-JSON (2026-10-11: a table of 20 holdings).
MAX_OUTPUT_TOKENS = 2500
#: Seconds one question may take, all turns included.
TIME_LIMIT = 120.0
#: Messages of the conversation sent with each question: the last three
#: exchanges. A starting value (MEMORY.md lists it as open); measured in PR 4.
HISTORY_MESSAGES = 6
#: Second chances per question: a reply that failed its check is sent back once
#: with what was wrong, and a model call that failed is made once more.
REPAIRS = 1

ReplyOutcome = Literal[
    "answer", "decline", "clarify", "failed", "budget_reached", "cap_reached", "no_model"
]

#: What the user reads when there is no checked reply. Server text, English
#: like every `/ask` answer until a decision says otherwise (guideline 1).
NO_REPLY_TEXT: dict[str, str] = {
    "failed": (
        "I couldn't give an answer I could check against the data, so I'm not showing one. "
        "Try asking again, or more narrowly."
    ),
    "budget_reached": (
        "The assistant has reached today's spending limit. It will answer again after midnight."
    ),
    "cap_reached": (
        "This month's spending limit for your account is reached. The assistant will answer "
        "again when the next month begins."
    ),
    "no_model": "The assistant needs a model, and none is configured. An admin can choose one.",
}
CLARIFY_BLANK = (
    "What would you like to know? You can ask about your portfolio, agents, a ticker, or "
    "how the app works."
)


@dataclass
class Turn:
    """What one question produced, as the router returns it."""

    conversation_id: str | None
    message_id: str | None
    outcome: ReplyOutcome
    text: str
    reason: str | None = None
    sources: list[dict[str, Any]] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)
    model: str | None = None
    cost_micro_usd: int = 0
    steps: int = 0
    problems: list[str] = field(default_factory=list)


async def ask(
    *,
    engine: Engine,
    llm: LLMProvider | None,
    context: ToolContext,
    question: str,
    conversation_id: str | None,
    now: datetime,
    timezone: str,
) -> Turn | None:
    """Answer `question` in `conversation_id` (a new conversation when None).

    None when `conversation_id` names no conversation of this user - the
    router's 404, the same for another user's conversation as for none.
    """
    user_id = context.user_id
    if not question.strip():
        # Nothing to answer and nothing worth storing: ask, at no cost.
        return Turn(
            conversation_id=conversation_id, message_id=None, outcome="clarify", text=CLARIFY_BLANK
        )

    with engine.begin() as connection:
        if conversation_id is None:
            conversation_id = conversations.start(connection, user_id, question)
            history: list[conversations.StoredMessage] = []
        else:
            if conversations.find(connection, user_id, conversation_id) is None:
                return None
            history = conversations.messages(connection, user_id, conversation_id)
        conversations.add_user_message(connection, user_id, conversation_id, question, now)

    state = LoopState(messages=[*_replayed(history[-HISTORY_MESSAGES:]), UserMessage(question)])
    earlier_results = [
        call["result"]
        for message in history
        for call in message.tool_calls
        if isinstance(call, dict) and call.get("role") == "tool" and "result" in call
    ]
    user_words = [m.content for m in history if m.role == "user"] + [question]

    turn = Turn(conversation_id=conversation_id, message_id=None, outcome="failed", text="")
    if llm is None:
        # No model at all: the question is kept, and the reply says what is missing.
        turn.outcome = "no_model"
    else:
        await _answer(
            turn,
            state,
            engine=engine,
            llm=llm,
            context=context,
            now=now,
            timezone=timezone,
            earlier_results=earlier_results,
            user_words=user_words,
        )
    return _store(engine, turn, state, user_id=user_id, conversation_id=conversation_id, now=now)


async def _answer(
    turn: Turn,
    state: LoopState,
    *,
    engine: Engine,
    llm: LLMProvider,
    context: ToolContext,
    now: datetime,
    timezone: str,
    earlier_results: list[Any],
    user_words: list[str],
) -> None:
    try:
        await asyncio.wait_for(
            _converse(
                turn,
                state,
                engine=engine,
                llm=llm,
                context=context,
                now=now,
                timezone=timezone,
                earlier_results=earlier_results,
                user_words=user_words,
            ),
            timeout=TIME_LIMIT,
        )
    except TimeoutError:
        turn.outcome, turn.problems = "failed", [f"the question ran past {TIME_LIMIT:.0f}s"]


def _store(
    engine: Engine,
    turn: Turn,
    state: LoopState,
    *,
    user_id: str,
    conversation_id: str,
    now: datetime,
) -> Turn:
    turn.model, turn.cost_micro_usd, turn.steps = state.model, state.cost_micro_usd, state.steps
    if turn.outcome in NO_REPLY_TEXT:
        turn.text, turn.reason, turn.suggestions = NO_REPLY_TEXT[turn.outcome], None, []
    turn.sources = sources([e for e in state.transcript if e.get("role") == "tool"])
    with engine.begin() as connection:
        turn.message_id = conversations.add_reply(
            connection,
            user_id=user_id,
            conversation_id=conversation_id,
            content=turn.text,
            outcome=turn.outcome,
            reason=turn.reason,
            sources=turn.sources,
            suggestions=turn.suggestions,
            tool_calls=state.transcript,
            model=turn.model,
            cost_micro_usd=turn.cost_micro_usd,
            at=datetime.now(now.tzinfo),
        )
    log.info(
        "assistant.replied",
        conversation_id=conversation_id,
        outcome=turn.outcome,
        steps=turn.steps,
        cost_micro_usd=turn.cost_micro_usd,
        problems=turn.problems,
    )
    return turn


def _replayed(history: list[conversations.StoredMessage]) -> list[Message]:
    """Earlier messages as the model reads them: the words exchanged, not the tools."""
    replayed: list[Message] = []
    for stored in history:
        if stored.role == "user":
            replayed.append(UserMessage(stored.content))
        elif stored.outcome in ("answer", "decline", "clarify"):
            replayed.append(AssistantMessage(stored.content))
    # A provider wants turns to alternate; a question left without a reply (it
    # failed) is followed by the next question, so drop the unanswered one.
    alternating: list[Message] = []
    for message in replayed:
        if alternating and type(alternating[-1]) is type(message):
            alternating.pop()
        alternating.append(message)
    return alternating


async def _converse(
    turn: Turn,
    state: LoopState,
    *,
    engine: Engine,
    llm: LLMProvider,
    context: ToolContext,
    now: datetime,
    timezone: str,
    earlier_results: list[Any],
    user_words: list[str],
) -> None:
    system = instructions(now=now, timezone=timezone, step_limit=STEP_LIMIT)

    async def run(name: str, arguments: str) -> str:
        return await run_any_tool(context, name, arguments, TOOLS_BY_NAME)

    for attempt in range(REPAIRS + 1):
        stop = await run_tool_loop(
            state,
            llm=llm,
            system=system,
            tools=[tool.spec for tool in TOOLS],
            run_tool=run,
            step_limit=STEP_LIMIT,
            max_output_tokens=MAX_OUTPUT_TOKENS,
            caller=Caller("assistant", user_id=context.user_id),
            within_budget=lambda: (
                not assistant_budget(
                    engine, context.user_id, datetime.now(now.tzinfo), timezone
                ).exhausted
            ),
        )
        if stop.end == "budget_reached":
            # The user's monthly cap is told apart from today's allowance: the
            # screen says a different reset for each.
            capped = isinstance(stop.cause, MonthlyCapReachedError)
            turn.outcome = "cap_reached" if capped else "budget_reached"
            return
        if stop.end != "answer" or stop.reply is None:
            turn.outcome = "no_model" if isinstance(stop.cause, LLMUnavailableError) else "failed"
            turn.problems = [stop.error or stop.end]
            # A failed call is asked once more, from where it stopped (measured
            # 2026-10-12: a real model's turn came back with no text at all).
            # Not when there is no model, and not past the step limit.
            if stop.end == "failed" and turn.outcome == "failed" and attempt < REPAIRS:
                continue
            return

        checked = check(
            stop.reply.text,
            tool_results=[*earlier_results, *state.tool_results],
            user_messages=user_words,
        )
        await llm.record_verdict(stop.reply.call_id, _verdict(checked))
        if checked.valid and checked.reply is not None:
            turn.outcome = checked.reply.outcome
            turn.text = checked.reply.text
            turn.reason = checked.reply.reason
            turn.suggestions = list(checked.reply.suggestions)
            turn.problems = []
            return
        turn.outcome, turn.problems = "failed", list(checked.problems)
        if attempt < REPAIRS:
            state.messages.append(UserMessage(_repair_request(checked)))


def _repair_request(checked: Checked) -> str:
    """What is sent back when a reply fails its check: the problem, and the rule."""
    return (
        "Your reply cannot be shown: "
        + "; ".join(checked.problems)
        + ". Every figure must appear in a tool result or in my words - look it up with a "
        "tool or leave it out. Reply again with the JSON only."
        + (
            ""
            if checked.reply is not None
            else ' The JSON is {"outcome", "reason" (declines only), "text", "suggestions"}.'
        )
    )


def _verdict(checked: Checked) -> Any:
    if checked.valid:
        return "accepted"
    if "degenerate" in checked.problems:
        return "degenerate_completion"
    if checked.unsourced:
        return "unsourced_figures"
    return "malformed"
