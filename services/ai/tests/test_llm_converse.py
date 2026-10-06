"""Tool calling (D15): one turn of a conversation, through every wrapper.

The provider describes tools and returns what the model asked for; it never runs
a tool or loops - that is the scan's. Every turn is budgeted and recorded like a
completion.
"""

from __future__ import annotations

import json
from decimal import Decimal

import httpx
import pytest

from app.llm.base import (
    AssistantMessage,
    Caller,
    LLMRequestError,
    LLMUnavailableError,
    ToolCall,
    ToolResultMessage,
    ToolSpec,
    UserMessage,
)
from app.llm.budget import BudgetedProvider, DailySpendGuard
from app.llm.call_log import CallEntry, RecordingProvider
from app.llm.model_choice import ChoosingProvider
from app.llm.null_provider import NullProvider
from app.llm.openai_compatible import OpenAICompatibleProvider
from app.llm.pricing import ModelPrice, estimate_cost_micro_usd
from tests.fakes import FakeRedis

SONNET = "anthropic/claude-sonnet-5.5"
GEMINI = "google/gemini-3.5-flash-lite"
PRICES = {
    SONNET: ModelPrice(Decimal("2"), Decimal("10")),
    GEMINI: ModelPrice(Decimal("0.3"), Decimal("2.5")),
}
QUOTE = ToolSpec(
    name="get_quote",
    description="The latest delayed quote for up to five symbols.",
    parameters={
        "type": "object",
        "properties": {"symbols": {"type": "array", "items": {"type": "string"}}},
        "required": ["symbols"],
    },
)
CALL = ToolCall(id="call_1", name="get_quote", arguments='{"symbols": ["NVDA"]}')
CONVERSATION = [
    UserMessage("Briefing: cash $10,000.00; no holdings."),
    AssistantMessage("Checking NVDA.", (CALL,)),
    ToolResultMessage("call_1", '{"NVDA": {"price": "182.40"}}'),
]


def _turn(*, content=None, tool_calls=None, model=SONNET) -> dict:
    message: dict = {"role": "assistant", "content": content}
    if tool_calls is not None:
        message["tool_calls"] = tool_calls
    return {
        "model": model,
        "choices": [{"message": message}],
        "usage": {"prompt_tokens": 4000, "completion_tokens": 120},
    }


def _provider(handler, model=SONNET) -> OpenAICompatibleProvider:
    return OpenAICompatibleProvider(
        name="openrouter",
        base_url="https://openrouter.test/api/v1",
        model=model,
        api_key="test-key",
        prices=PRICES,
        retry_backoff_seconds=0.0,
        transport=httpx.MockTransport(handler),
    )


def _capture(seen: dict, response: dict):
    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=response)

    return handler


async def test_a_turn_sends_the_tools_and_the_conversation_in_order():
    seen: dict = {}
    reply = _turn(tool_calls=[{"id": "c2", "function": {"name": "get_quote", "arguments": "{}"}}])
    await _provider(_capture(seen, reply), model=GEMINI).converse(
        system="You are an agent.", messages=CONVERSATION, tools=[QUOTE]
    )
    body = seen["body"]
    assert body["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "get_quote",
                "description": QUOTE.description,
                "parameters": dict(QUOTE.parameters),
            },
        }
    ]
    assert [message["role"] for message in body["messages"]] == [
        "system",
        "user",
        "assistant",
        "tool",
    ]
    assistant, tool = body["messages"][2], body["messages"][3]
    assert assistant["tool_calls"][0]["function"] == {
        "name": "get_quote",
        "arguments": CALL.arguments,
    }
    assert tool == {"role": "tool", "tool_call_id": "call_1", "content": CONVERSATION[2].content}
    # Not an Anthropic model: plain strings, no cache markers.
    assert body["messages"][0]["content"] == "You are an agent."
    assert body["messages"][1]["content"] == CONVERSATION[0].text


async def test_an_anthropic_model_caches_the_instructions_and_the_briefing_only():
    seen: dict = {}
    await _provider(_capture(seen, _turn(content="Nothing to do."))).converse(
        system="You are an agent.", messages=CONVERSATION, tools=[QUOTE]
    )
    system, briefing, assistant, tool = seen["body"]["messages"]
    marker = {"type": "ephemeral"}
    assert system["content"][0]["cache_control"] == marker
    assert briefing["content"][0] == {
        "type": "text",
        "text": CONVERSATION[0].text,
        "cache_control": marker,
    }
    assert isinstance(tool["content"], str) and "cache_control" not in assistant


async def test_a_turn_of_tool_calls_and_no_text_is_an_answer():
    reply = _turn(
        tool_calls=[
            {"id": "c1", "function": {"name": "get_quote", "arguments": '{"symbols":["AMD"]}'}},
            {"id": "c2", "function": {"name": "get_news"}},
            {"id": "c3", "function": {}},
        ]
    )
    turn = await _provider(lambda request: httpx.Response(200, json=reply)).converse(
        system="s", messages=CONVERSATION[:1], tools=[QUOTE]
    )
    assert turn.text == ""
    assert turn.tool_calls == (
        ToolCall("c1", "get_quote", '{"symbols":["AMD"]}'),
        ToolCall("c2", "get_news", "{}"),
    )
    assert turn.estimated_cost_micro_usd == estimate_cost_micro_usd(SONNET, turn.usage, PRICES)


async def test_a_turn_with_neither_text_nor_tool_calls_is_refused_and_still_charged():
    provider = _provider(lambda request: httpx.Response(200, json=_turn(content="")))
    with pytest.raises(LLMRequestError) as refused:
        await provider.converse(system="s", messages=CONVERSATION[:1], tools=[QUOTE])
    assert refused.value.metered_micro_usd > 0


async def test_complete_ignores_tool_calls_it_never_offered():
    reply = _turn(content="text", tool_calls=[{"id": "c", "function": {"name": "x"}}])
    completion = await _provider(lambda request: httpx.Response(200, json=reply)).complete(
        system=None, user="u"
    )
    assert completion.tool_calls == ()


class _Log:
    def __init__(self) -> None:
        self.entries: list[CallEntry] = []

    def record(self, entry: CallEntry) -> int:
        self.entries.append(entry)
        return len(self.entries)

    def set_verdict(self, call_id, verdict) -> None:
        return None


async def test_each_turn_is_recorded_with_only_what_it_added():
    log = _Log()
    reply = _turn(tool_calls=[{"id": "c9", "function": {"name": "get_quote", "arguments": "{}"}}])
    provider = RecordingProvider(
        _provider(lambda request: httpx.Response(200, json=reply)), log, model=SONNET
    )
    caller = Caller(purpose="agent_scan", user_id="u", agent_id="a")
    await provider.converse(system="RULES", messages=CONVERSATION[:1], tools=[QUOTE], caller=caller)
    await provider.converse(system="RULES", messages=CONVERSATION, tools=[QUOTE], caller=caller)
    first, second = log.entries
    assert first.prompt.startswith("[system]\nRULES") and "Briefing" in first.prompt
    assert "RULES" not in second.prompt and "Briefing" not in second.prompt
    assert second.prompt.startswith("[2 earlier messages]") and "[tool call_1]" in second.prompt
    assert (second.purpose, second.agent_id) == ("agent_scan", "a")
    assert second.completion == "\n-> get_quote({})"


async def test_a_turn_is_budgeted_like_a_completion():
    guard = DailySpendGuard(FakeRedis(), Decimal("0.000001"))
    provider = BudgetedProvider(
        _provider(lambda request: httpx.Response(200, json=_turn(content="ok"))), guard
    )
    await provider.converse(system="s", messages=CONVERSATION[:1], tools=[QUOTE])
    with pytest.raises(Exception, match="budget"):
        await provider.converse(system="s", messages=CONVERSATION[:1], tools=[QUOTE])


async def test_no_model_means_no_turn():
    with pytest.raises(LLMUnavailableError):
        await NullProvider().converse(system="s", messages=CONVERSATION[:1], tools=[QUOTE])


async def test_a_scan_uses_the_model_chosen_for_agents():
    seen: dict = {}

    class Choices:
        def chosen(self, scope):
            return {"agent": GEMINI, "explain": SONNET}[scope]

    provider = ChoosingProvider(_provider(_capture(seen, _turn(content="ok"))), Choices())
    await provider.converse(
        system="s",
        messages=CONVERSATION[:1],
        tools=[QUOTE],
        caller=Caller(purpose="agent_scan", user_id="u", agent_id="a"),
    )
    assert seen["body"]["model"] == GEMINI
