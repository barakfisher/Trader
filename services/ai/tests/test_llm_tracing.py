"""Every model call is also a Langfuse trace, and tracing never costs a call (D375).

What is pinned here: tracing is off without both keys; with them, the recording
wrapper sends each call as a `generation` - refused ones too - with the model,
tokens, this service's own cost and the conversation; a tool call is a `tool`
beside the generation that asked for it; the caller's verdict becomes a score;
`capture_text` off sends no prompt, reply or tool result; and a Langfuse that
breaks changes nothing the caller gets back.

Hermetic: spans go to an in-memory exporter and scores to an `httpx`
MockTransport, so nothing leaves the process and no key is real.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import httpx
import pytest
from langfuse._client.attributes import LangfuseOtelSpanAttributes as Attr
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from app.config import Settings
from app.llm import tracing
from app.llm.base import (
    Caller,
    LLMBudgetExceededError,
    LLMCompletion,
    TokenUsage,
    ToolCall,
    ToolSpec,
    UserMessage,
    Verdict,
    micro_usd_to_usd,
)
from app.llm.call_log import CallEntry, RecordingProvider
from app.llm.tool_loop import LoopState, run_tool_loop

USER_ID = "00000000-0000-0000-0000-000000000001"
CALLER = Caller(purpose="narration", user_id=USER_ID)
COST_MICRO_USD = 231
TOOL = ToolSpec(name="get_quote", description="A quote.", parameters={"type": "object"})


class MemoryLog:
    def __init__(self) -> None:
        self.entries: list[CallEntry] = []

    def record(self, entry: CallEntry) -> int:
        self.entries.append(entry)
        return len(self.entries)

    def set_verdict(self, call_id: int, verdict: Verdict) -> None:
        return None


class Provider:
    """Answers with a tool call first when given tools, then with text."""

    name = "stub"
    charges_per_token = True

    def __init__(self, error: Exception | None = None) -> None:
        self._error = error
        self.turns = 0

    def _reply(self, text: str, tool_calls: tuple[ToolCall, ...] = ()) -> LLMCompletion:
        return LLMCompletion(
            text=text,
            model="stub-model-2026",
            usage=TokenUsage(prompt_tokens=120, completion_tokens=40),
            estimated_cost_micro_usd=COST_MICRO_USD,
            provider="stub",
            tool_calls=tool_calls,
        )

    async def complete(self, **_kwargs: object) -> LLMCompletion:
        if self._error:
            raise self._error
        return self._reply('{"headline": "h", "explanation": "e"}')

    async def converse(self, *, tools: list[ToolSpec], **_kwargs: object) -> LLMCompletion:
        self.turns += 1
        if tools and self.turns == 1:
            return self._reply("", (ToolCall("call-1", "get_quote", '{"symbol": "AAPL"}'),))
        return self._reply("AAPL is at 190.")

    async def record_verdict(self, call_id: int | None, verdict: Verdict) -> None:
        return None


@dataclass
class Sent:
    exporter: InMemorySpanExporter
    requests: list[httpx.Request]

    def spans(self) -> list[ReadableSpan]:
        tracing.flush()
        return list(self.exporter.get_finished_spans())

    def span(self, name: str) -> ReadableSpan:
        [span] = [s for s in self.spans() if s.name == name]
        return span


def _install(*, capture_text: bool, **options: Any) -> Sent:
    exporter = InMemorySpanExporter()
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={})

    started = tracing.install(
        # A key of its own per test: the SDK keeps one client per public key.
        public_key=f"pk-lf-test-{uuid.uuid4()}",
        secret_key="sk-lf-test",
        base_url="http://langfuse.invalid",
        environment="test",
        capture_text=capture_text,
        span_exporter=exporter,
        httpx_client=httpx.Client(transport=httpx.MockTransport(handler)),
        **options,
    )
    assert started
    return Sent(exporter, requests)


@pytest.fixture
def sent() -> Iterator[Sent]:
    yield _install(capture_text=True)
    tracing.shutdown()


@pytest.fixture
def sent_without_text() -> Iterator[Sent]:
    yield _install(capture_text=False)
    tracing.shutdown()


def _attr(span: ReadableSpan, key: str) -> Any:
    value = (span.attributes or {}).get(key)
    return json.loads(value) if isinstance(value, str) and value[:1] in "[{" else value


def _metadata(span: ReadableSpan, key: str) -> Any:
    return json.loads((span.attributes or {})[f"{Attr.OBSERVATION_METADATA}.{key}"])


async def _complete(provider: Provider | None = None) -> LLMCompletion:
    recording = RecordingProvider(provider or Provider(), MemoryLog(), model="configured")
    return await recording.complete(system="rules", user="evidence", caller=CALLER)


def test_without_both_keys_nothing_is_traced() -> None:
    for public_key, secret_key in [(None, None), ("pk-lf-only", None), (None, "sk-lf-only")]:
        assert not tracing.install(
            public_key=public_key,
            secret_key=secret_key,
            base_url="http://langfuse.invalid",
            environment="test",
            capture_text=True,
        )
        with tracing.observe("answer-question") as observation:
            observation.update(output="nothing is sent")
        assert observation.ids is None


def test_settings_leave_tracing_off_and_point_at_the_eu_cloud() -> None:
    settings = Settings(_env_file=None)
    assert settings.langfuse_public_key is None and settings.langfuse_secret_key is None
    assert settings.langfuse_base_url == Settings.model_fields["langfuse_base_url"].default
    assert settings.langfuse_capture_text is Settings.model_fields["langfuse_capture_text"].default


def test_a_blank_capture_text_line_means_the_default_not_a_failed_boot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LANGFUSE_CAPTURE_TEXT", "")
    settings = Settings(_env_file=None)
    assert settings.langfuse_capture_text is Settings.model_fields["langfuse_capture_text"].default
    monkeypatch.setenv("LANGFUSE_CAPTURE_TEXT", "false")
    assert Settings(_env_file=None).langfuse_capture_text is False


async def test_a_completed_call_is_a_generation_with_its_model_tokens_cost_and_messages(
    sent: Sent,
) -> None:
    completion = await _complete()
    span = sent.span("generate-narration")
    assert _attr(span, Attr.OBSERVATION_TYPE) == "generation"
    assert _attr(span, Attr.OBSERVATION_MODEL) == "stub-model-2026"
    assert _attr(span, Attr.OBSERVATION_USAGE_DETAILS) == {"input": 120, "output": 40}
    assert _attr(span, Attr.OBSERVATION_COST_DETAILS) == {
        "total": float(micro_usd_to_usd(COST_MICRO_USD))
    }
    assert _attr(span, Attr.OBSERVATION_INPUT) == [
        {"role": "system", "content": "rules"},
        {"role": "user", "content": "evidence"},
    ]
    assert _attr(span, Attr.OBSERVATION_OUTPUT) == {"role": "assistant", "content": completion.text}
    assert _attr(span, Attr.TRACE_USER_ID) == USER_ID
    assert list(_attr(span, Attr.TRACE_TAGS)) == ["narration"]
    assert _metadata(span, "llm_call_id") == completion.call_id
    assert _metadata(span, "outcome") == "ok"
    assert span.resource.attributes["service.name"] == tracing.SERVICE_NAME


async def test_a_refused_call_is_traced_with_its_reason_and_still_reaches_the_caller(
    sent: Sent,
) -> None:
    with pytest.raises(LLMBudgetExceededError):
        await _complete(Provider(LLMBudgetExceededError(5_000_000, 5_000_000, "2026-11-03")))
    span = sent.span("generate-narration")
    assert _attr(span, Attr.OBSERVATION_LEVEL) == "WARNING"
    assert _metadata(span, "outcome") == "budget_exhausted"
    assert "LLMBudgetExceededError" in _attr(span, Attr.OBSERVATION_STATUS_MESSAGE)
    assert _attr(span, Attr.OBSERVATION_OUTPUT) is None


async def test_a_tool_call_is_a_tool_beside_the_generation_that_asked_for_it(
    sent: Sent,
) -> None:
    provider = RecordingProvider(Provider(), MemoryLog(), model="configured")

    async def run_tool(name: str, arguments: str) -> str:
        return json.dumps({"symbol": "AAPL", "price": "190.00"})

    with tracing.observe("answer-question", as_type="agent", input="AAPL?", session_id="c-1"):
        await run_tool_loop(
            LoopState(messages=[UserMessage("AAPL?")]),
            llm=provider,
            system="rules",
            tools=[TOOL],
            run_tool=run_tool,
            step_limit=3,
            max_output_tokens=500,
            caller=Caller(purpose="assistant", user_id=USER_ID),
            within_budget=lambda: True,
        )

    root = sent.span("answer-question")
    tool = sent.span("get_quote")
    generations = [s for s in sent.spans() if s.name == "generate-assistant"]
    assert len(generations) == 2
    assert _attr(tool, Attr.OBSERVATION_TYPE) == "tool"
    assert _attr(tool, Attr.OBSERVATION_INPUT) == {"symbol": "AAPL"}
    assert _attr(tool, Attr.OBSERVATION_OUTPUT) == {"symbol": "AAPL", "price": "190.00"}
    for child in [tool, *generations]:
        assert child.parent is not None and child.parent.span_id == root.context.span_id
        assert _attr(child, Attr.TRACE_SESSION_ID) == "c-1"
    # The second turn's input replays the tool call and its result, so the
    # generation shows what the model saw when it answered.
    second = max(generations, key=lambda s: s.start_time or 0)
    replayed = _attr(second, Attr.OBSERVATION_INPUT)
    assert replayed[-2]["tool_calls"][0]["function"]["name"] == "get_quote"
    assert replayed[-1] == {
        "role": "tool",
        "tool_call_id": "call-1",
        "content": json.dumps({"symbol": "AAPL", "price": "190.00"}),
    }


async def test_a_verdict_is_a_score_on_the_generation_it_judges(sent: Sent) -> None:
    provider = RecordingProvider(Provider(), MemoryLog(), model="configured")
    completion = await provider.complete(system="rules", user="evidence", caller=CALLER)
    await provider.record_verdict(completion.call_id, "unsourced_figures")
    span = sent.span("generate-narration")
    [score] = [
        item
        for request in sent.requests
        if request.url.path.endswith("/scores")
        for item in json.loads(request.content)
    ]
    assert score["name"] == tracing.VERDICT_SCORE
    assert score["value"] == "unsourced_figures"
    assert score["dataType"] == "CATEGORICAL"
    assert score["observationId"] == format(span.context.span_id, "016x")
    assert score["traceId"] == format(span.context.trace_id, "032x")


async def test_with_text_off_no_prompt_reply_or_tool_result_is_sent(
    sent_without_text: Sent,
) -> None:
    provider = RecordingProvider(Provider(), MemoryLog(), model="configured")

    async def run_tool(name: str, arguments: str) -> str:
        return json.dumps({"price": "190.00"})

    with tracing.observe("answer-question", as_type="agent", input="my portfolio") as root:
        await run_tool_loop(
            LoopState(messages=[UserMessage("my portfolio")]),
            llm=provider,
            system="rules",
            tools=[TOOL],
            run_tool=run_tool,
            step_limit=3,
            max_output_tokens=500,
            caller=Caller(purpose="assistant", user_id=USER_ID),
            within_budget=lambda: True,
        )
        root.update(output="the answer")

    spans = sent_without_text.spans()
    assert {s.name for s in spans} == {"answer-question", "generate-assistant", "get_quote"}
    for span in spans:
        attributes = span.attributes or {}
        assert Attr.OBSERVATION_INPUT not in attributes
        assert Attr.OBSERVATION_OUTPUT not in attributes
    generation = next(s for s in spans if s.name == "generate-assistant")
    assert _attr(generation, Attr.OBSERVATION_MODEL) == "stub-model-2026"
    assert _attr(generation, Attr.OBSERVATION_USAGE_DETAILS) == {"input": 120, "output": 40}


class BrokenClient:
    """A Langfuse client every method of which fails."""

    def __getattr__(self, name: str) -> Any:
        def fail(*_args: object, **_kwargs: object) -> None:
            raise RuntimeError(f"langfuse is broken: {name}")

        return fail


async def test_a_broken_langfuse_changes_nothing_for_the_caller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tracing._state, "client", BrokenClient())
    log = MemoryLog()
    provider = RecordingProvider(Provider(), log, model="configured")
    completion = await provider.complete(system="rules", user="evidence", caller=CALLER)
    await provider.record_verdict(completion.call_id, "accepted")
    assert completion.text == '{"headline": "h", "explanation": "e"}'
    assert completion.call_id == 1 and len(log.entries) == 1


async def test_an_error_inside_an_observation_is_recorded_and_reraised(sent: Sent) -> None:
    with (
        pytest.raises(ValueError, match="scan blew up"),
        tracing.observe("agent-scan", as_type="agent"),
    ):
        raise ValueError("scan blew up")
    span = sent.span("agent-scan")
    assert _attr(span, Attr.OBSERVATION_LEVEL) == "ERROR"


async def test_figures_and_times_reach_langfuse_exactly(sent: Sent) -> None:
    with tracing.observe(
        "narrate-finding", input={"as_of": datetime(2026, 11, 3, 14, 30, tzinfo=UTC)}
    ) as observation:
        observation.update(output={"price": Decimal("190.05"), "quantity": Decimal("0.125")})
    span = sent.span("narrate-finding")
    assert _attr(span, Attr.OBSERVATION_INPUT) == {"as_of": "2026-11-03T14:30:00+00:00"}
    assert _attr(span, Attr.OBSERVATION_OUTPUT) == {"price": "190.05", "quantity": "0.125"}
