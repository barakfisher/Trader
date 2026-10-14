"""How the reasoning knob is sent, and why the least effort is not just a smaller one.

Measured on a free reasoning route: the real narration prompt drew 1707
reasoning tokens against a 700-token output budget, so every reply ended
`finish_reason: length` - and a reply truncated mid-thought comes back with the
*reasoning* in `content`. The symptom was a model apparently ignoring "reply
with JSON only"; the cause was a token budget spent before the answer began.

`exclude` does not fix it - it hides the reasoning and still spends the tokens.
Asking for the least effort does, and the same model then answers inside the
original budget. These tests pin the request shape, because the difference
between the spellings is invisible in the response and expensive in the reply.
"""

from __future__ import annotations

from app.llm.base import LEAST_REASONING
from app.llm.openai_compatible import OpenAICompatibleProvider


def _payload(effort: str | None, per_call: str | None = None) -> dict:
    """The body the provider would send, without sending it."""
    provider = OpenAICompatibleProvider(
        name="openrouter",
        base_url="https://example.invalid/v1",
        api_key="test-key",
        model="some/model:free",
        reasoning_effort=effort,
    )
    return provider._build_payload(system="s", user="u", temperature=0.1, reasoning_effort=per_call)


def test_the_least_effort_is_passed_through_as_an_effort() -> None:
    assert _payload(LEAST_REASONING)["reasoning"] == {"effort": LEAST_REASONING}


def test_the_least_effort_is_not_the_one_openrouter_refuses() -> None:
    """`"none"` is a 400 on reasoning-mandatory routes ("Reasoning is mandatory
    for this endpoint and cannot be disabled") - Sonnet 5.5 and Flash-Lite both,
    from October 2026. Narration sent it and fell back to its template on every
    call for a week. This is a fact about the gateway, not a tuning value."""
    assert LEAST_REASONING != "none"


def test_an_effort_is_passed_through_as_an_effort() -> None:
    assert _payload("low")["reasoning"] == {"effort": "low"}


def test_unset_says_nothing_and_leaves_the_model_to_decide() -> None:
    """Distinct from the least effort: absent is not the same request, nor the same bill."""
    assert "reasoning" not in _payload(None)


def test_the_call_overrides_the_deployment_default() -> None:
    """How much a model should think is a property of the task, not the install.

    Narration passes the least effort at its own call site. Without this, that
    choice would apply to every later caller too - an agent with a real
    judgement to make would silently inherit a setting chosen by a task that
    has none.
    """
    assert _payload("low", per_call=LEAST_REASONING)["reasoning"] == {"effort": LEAST_REASONING}
    assert _payload(LEAST_REASONING, per_call="high")["reasoning"] == {"effort": "high"}


def test_no_opinion_is_not_the_same_as_an_opinion() -> None:
    """`None` defers to the deployment; a string overrules it."""
    assert _payload("low", per_call=None)["reasoning"] == {"effort": "low"}
