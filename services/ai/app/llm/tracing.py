"""Model calls and the work around them, sent to Langfuse as traces (D375).

`llm_calls` answers "which call was slow, costly or failing" one row at a time.
A trace answers what a row cannot: which tool a scan called after which reply,
what the conversation was at each turn, and why it ended where it did. One unit
of work is one trace - a scan, a question, a narration, a mandate check, a
research run - with a `generation` for each model call and a `tool` for each
tool the model asked for, nested where they happened.

This module is the only one that imports `langfuse`. Call sites open an
observation with `observe(...)`; the recording wrapper (`call_log.py`) opens
each `generation`, so a call refused for budget or for want of a model is
traced as well as one that reached a model, exactly as it is recorded.

**Tracing never fails the work it watches.** Every call into the SDK is
guarded: a Langfuse that is down, misconfigured or broken costs a log line,
never a narration. The SDK itself sends from a background thread in batches,
so a request does not wait for Langfuse either. The same rule as `call_log.py`:
observability that can take down narration is the wrong way round.

**Off by default.** Without both keys `install` leaves tracing disabled, and
every function here is then a no-op: tests, CI and a stack without an account
send nothing and need no network.

**Text can be withheld.** With `capture_text` off, no input or output leaves
this module - no prompt, reply, question or tool result - only names, models,
token counts, cost, timing, outcomes and ids. Prompts carry portfolio data, so
this is the switch that must be off (or Langfuse self-hosted) before the
installation serves anyone but its owner (D375).
"""

from __future__ import annotations

import json
import sys
from collections import OrderedDict
from collections.abc import Iterator, Mapping, Sequence
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from app.core.logging import get_logger
from app.llm.base import (
    AssistantMessage,
    Caller,
    Message,
    ToolCall,
    ToolResultMessage,
    UserMessage,
    Verdict,
    micro_usd_to_usd,
)

log = get_logger("llm.tracing")

ObservationType = Literal["span", "agent", "tool", "chain"]
Level = Literal["DEFAULT", "WARNING", "ERROR"]

#: How many recent calls keep the ids their verdict is scored against. A verdict
#: arrives right after its call, so this only bounds memory; one that arrives
#: later than this many calls is logged and dropped, never an error.
VERDICT_MEMORY = 512

#: What the traces say sent them, in place of OpenTelemetry's `unknown_service`.
SERVICE_NAME = "traders-ai-service"

#: The score a call's verdict is recorded under (`Verdict`, from `base.py`).
VERDICT_SCORE = "verdict"


@dataclass
class _State:
    client: Any = None
    capture_text: bool = True


_state = _State()
#: `llm_calls.id` -> (trace id, observation id) of the generation it was traced as.
_generations: OrderedDict[int, tuple[str, str]] = OrderedDict()


def install(
    *,
    public_key: str | None,
    secret_key: str | None,
    base_url: str,
    environment: str,
    capture_text: bool,
    **client_options: Any,
) -> bool:
    """Start tracing to Langfuse when both keys are set; whether it started.

    `client_options` reach `Langfuse(...)` unchanged: tests pass an in-memory
    `span_exporter` and an `httpx_client`, so nothing leaves the process.
    """
    shutdown()
    _state.capture_text = capture_text
    if not public_key or not secret_key:
        if public_key or secret_key:
            log.warning("tracing.half_configured", hint="set both LANGFUSE keys, or neither")
        return False
    try:
        from langfuse import Langfuse
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider

        _state.client = Langfuse(
            public_key=public_key,
            secret_key=secret_key,
            base_url=base_url,
            environment=environment,
            # A provider of its own rather than the process-wide one: only what
            # this module opens is exported, never another library's HTTP or
            # database spans.
            tracer_provider=client_options.pop("tracer_provider", None)
            or TracerProvider(resource=Resource.create({"service.name": SERVICE_NAME})),
            **client_options,
        )
    except Exception as error:  # noqa: BLE001 - tracing never stops the service
        log.warning("tracing.not_started", error=str(error))
        _state.client = None
        return False
    log.info("tracing.started", base_url=base_url, environment=environment, text=capture_text)
    return True


def shutdown() -> None:
    """Send what is buffered and stop. Safe to call when tracing never started."""
    client, _state.client = _state.client, None
    _generations.clear()
    if client is not None:
        _guarded("shutdown", client.shutdown)


def flush() -> None:
    """Send what is buffered now (tests, and a script about to exit)."""
    if _state.client is not None:
        _guarded("flush", _state.client.flush)


class Observation:
    """An open observation, or nothing when tracing is off. Updates are guarded."""

    def __init__(self, span: Any = None) -> None:
        self._span = span
        #: Whether a level was given; an exception passing through keeps it.
        self.leveled = False

    def update(
        self,
        *,
        input: Any = None,
        output: Any = None,
        metadata: Mapping[str, Any] | None = None,
        level: Level | None = None,
        status_message: str | None = None,
        **generation: Any,
    ) -> None:
        if self._span is None:
            return
        self.leveled = self.leveled or level is not None
        fields: dict[str, Any] = {
            key: value
            for key, value in {
                "metadata": {k: v for k, v in (metadata or {}).items() if v is not None} or None,
                "level": level,
                "status_message": status_message,
                **generation,
            }.items()
            if value is not None
        }
        if _state.capture_text:
            fields |= {
                k: _plain(v) for k, v in {"input": input, "output": output}.items() if v is not None
            }
        if fields:
            _guarded("update", lambda: self._span.update(**fields))

    @property
    def ids(self) -> tuple[str, str] | None:
        """(trace id, observation id), or None when nothing was opened."""
        if self._span is None:
            return None
        return self._span.trace_id, self._span.id


@contextmanager
def observe(
    name: str,
    *,
    as_type: ObservationType = "span",
    input: Any = None,
    user_id: str | None = None,
    session_id: str | None = None,
    tags: Sequence[str] = (),
    metadata: Mapping[str, Any] | None = None,
) -> Iterator[Observation]:
    """An observation around the block, the parent of what the block opens.

    Opened outside any other it is a trace's root, and `name` is the trace's
    name too. Names are stable, verb first and never carry a value (an id or a
    symbol goes in `metadata`): filters and dashboards in Langfuse match on them.
    The user, session and tags reach every observation opened inside.
    An exception from the block is recorded on the observation and re-raised.
    """
    with _opened(
        name,
        as_type=as_type,
        input=input,
        metadata=metadata,
        user_id=user_id,
        session_id=session_id,
        tags=tags,
    ) as observation:
        yield observation


@contextmanager
def generation(
    *,
    caller: Caller | None,
    model: str | None,
    system: str | None,
    messages: Sequence[Message],
    model_parameters: Mapping[str, Any],
    tools: Sequence[str] = (),
) -> Iterator[Observation]:
    """One model call, as a `generation` named after what it is for.

    The input is the conversation as the model was sent it, in OpenAI's message
    format, so Langfuse renders roles and tool calls rather than a JSON blob.
    """
    purpose = caller.purpose if caller else "unknown"
    metadata: dict[str, Any] = {"purpose": purpose, "agent_id": caller.agent_id if caller else None}
    if tools:
        metadata["tools_offered"] = list(tools)
    with _opened(
        f"generate-{purpose.replace('_', '-')}",
        as_type="generation",
        input=wire_messages(system, messages),
        metadata=metadata,
        user_id=caller.user_id if caller else None,
        tags=(purpose,),
        model=model,
        model_parameters={k: v for k, v in model_parameters.items() if v is not None},
    ) as observation:
        yield observation


def finish_generation(
    observation: Observation,
    *,
    model: str | None,
    text: str | None,
    tool_calls: Sequence[ToolCall],
    prompt_tokens: int,
    completion_tokens: int,
    cost_micro_usd: int,
    outcome: str,
    error: str | None,
    call_id: int | None,
    paid_by: str,
) -> None:
    """What the call returned or why it did not, and what it cost.

    The cost is this service's own estimate (`pricing.py`), the figure the
    admin page shows, rather than Langfuse's price table: OpenRouter's model ids
    are not in it, and two numbers for one call would disagree.
    """
    output: dict[str, Any] | None = None
    if text is not None:
        output = {"role": "assistant", "content": text or None}
        if tool_calls:
            output["tool_calls"] = _wire_tool_calls(tool_calls)
    observation.update(
        output=output,
        metadata={"outcome": outcome, "llm_call_id": call_id, "paid_by": paid_by},
        level=_level(outcome),
        status_message=error,
        model=model,
        usage_details={"input": prompt_tokens, "output": completion_tokens},
        # Integer micro-USD becomes a decimal amount once, here, and a float only
        # because the SDK's field is one: this leaves the service as telemetry,
        # and nothing reads it back (guideline 3).
        cost_details={"total": float(micro_usd_to_usd(cost_micro_usd))},
    )
    if call_id is not None and (ids := observation.ids) is not None:
        _generations[call_id] = ids
        while len(_generations) > VERDICT_MEMORY:
            _generations.popitem(last=False)


def score_verdict(call_id: int | None, verdict: Verdict) -> None:
    """The caller's verdict on a call, as a categorical score on its generation."""
    client = _state.client
    if client is None or call_id is None:
        return
    ids = _generations.pop(call_id, None)
    if ids is None:
        log.info("tracing.verdict_unmatched", call_id=call_id)
        return
    trace_id, observation_id = ids
    _guarded(
        "score",
        lambda: client.create_score(
            name=VERDICT_SCORE,
            value=verdict,
            data_type="CATEGORICAL",
            trace_id=trace_id,
            observation_id=observation_id,
        ),
    )


def wire_messages(system: str | None, messages: Sequence[Message]) -> list[dict[str, Any]]:
    """The conversation in OpenAI's message format, which Langfuse renders as one."""
    wire: list[dict[str, Any]] = [{"role": "system", "content": system}] if system else []
    for message in messages:
        if isinstance(message, UserMessage):
            wire.append({"role": "user", "content": message.text})
        elif isinstance(message, AssistantMessage):
            turn: dict[str, Any] = {"role": "assistant", "content": message.text or None}
            if message.tool_calls:
                turn["tool_calls"] = _wire_tool_calls(message.tool_calls)
            wire.append(turn)
        elif isinstance(message, ToolResultMessage):
            wire.append(
                {"role": "tool", "tool_call_id": message.call_id, "content": message.content}
            )
    return wire


def parsed(text: str) -> Any:
    """A tool's JSON arguments or result as data, so Langfuse shows it as a tree;
    the text itself when it is not JSON - a model can write anything there."""
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return text


def _plain(value: Any) -> Any:
    """`value` as plain JSON data. The SDK writes a Decimal as `"<Decimal>"`, which
    would drop every figure a scan or a rating carries: here it is its exact
    string, never a float (guideline 3), and a datetime its ISO 8601 text."""
    if value is None or isinstance(value, str | int | float | bool):
        return value
    return json.loads(json.dumps(value, default=_jsonable, ensure_ascii=False))


def _jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, set | frozenset | tuple):
        return list(value)
    return str(value)


def _wire_tool_calls(calls: Sequence[ToolCall]) -> list[dict[str, Any]]:
    return [
        {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}}
        for c in calls
    ]


def _level(outcome: str) -> Level:
    if outcome == "ok":
        return "DEFAULT"
    # Refused before a model was asked: the day's budget, or no model at all.
    if outcome in ("budget_exhausted", "no_provider"):
        return "WARNING"
    return "ERROR"


@contextmanager
def _opened(
    name: str,
    *,
    as_type: str,
    input: Any,
    metadata: Mapping[str, Any] | None,
    user_id: str | None = None,
    session_id: str | None = None,
    tags: Sequence[str] = (),
    **generation: Any,
) -> Iterator[Observation]:
    client = _state.client
    if client is None:
        yield Observation()
        return
    stack = ExitStack()
    observation = Observation()
    try:
        from langfuse import propagate_attributes

        span = stack.enter_context(
            client.start_as_current_observation(
                name=name,
                as_type=as_type,
                input=_plain(input) if _state.capture_text else None,
                metadata={k: v for k, v in (metadata or {}).items() if v is not None} or None,
                **generation,
            )
        )
        attributes: dict[str, Any] = {"user_id": user_id, "session_id": session_id}
        stack.enter_context(
            propagate_attributes(
                **{k: v for k, v in attributes.items() if v is not None},
                tags=list(tags) or None,
            )
        )
        observation = Observation(span)
    except Exception as error:  # noqa: BLE001 - tracing never fails the work
        log.warning("tracing.not_opened", name=name, error=str(error))
        _guarded("close", stack.close)
    try:
        yield observation
    except BaseException as error:
        failure = sys.exc_info()
        # The SDK marks the span's status; Langfuse filters by level, so say it
        # there - unless the block already did (a refused call is a warning).
        if not observation.leveled:
            message = f"{type(error).__name__}: {error}"[:500]
            observation.update(level="ERROR", status_message=message)
        _guarded("close", lambda: stack.__exit__(*failure))
        raise
    else:
        _guarded("close", stack.close)


def _guarded(action: str, call: Any) -> None:
    try:
        call()
    except Exception as error:  # noqa: BLE001 - tracing never fails the work
        log.warning("tracing.failed", action=action, error=str(error))
