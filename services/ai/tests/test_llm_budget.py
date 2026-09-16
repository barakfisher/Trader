"""The daily spend ceiling.

A misconfigured or unenforced budget is silent by nature: nothing crashes, the
bill simply grows. These tests pin the behaviour that makes it loud instead.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from app.llm.base import (
    MICRO_USD_PER_USD,
    LLMBudgetExceededError,
    LLMCompletion,
    LLMRequestError,
    TokenUsage,
)
from app.llm.budget import BudgetedProvider, DailySpendGuard
from tests.fakes import FakeRedis


class _StubProvider:
    """An LLM that costs whatever the test says it costs."""

    name = "stub"
    charges_per_token = True

    def __init__(self, cost_micro_usd: int = 1_000, error: Exception | None = None) -> None:
        self._cost = cost_micro_usd
        self._error = error
        self.calls = 0

    async def complete(self, *, system, user, max_output_tokens=None, temperature=None):
        self.calls += 1
        if self._error is not None:
            raise self._error
        return LLMCompletion(
            text="narration",
            model="test-model",
            usage=TokenUsage(prompt_tokens=100, completion_tokens=50),
            estimated_cost_micro_usd=self._cost,
            provider=self.name,
        )


class _LocalStub(_StubProvider):
    """A local runtime: reached over HTTP, but never billed per token."""

    name = "ollama"
    charges_per_token = False


def _guard(redis: FakeRedis, cap_usd: str) -> DailySpendGuard:
    return DailySpendGuard(redis, Decimal(cap_usd))


async def _complete(provider: BudgetedProvider) -> LLMCompletion:
    return await provider.complete(system=None, user="finding")


# -- the cap ------------------------------------------------------------------


async def test_a_cap_is_expressed_in_micro_usd():
    # Spend is counted in micro-USD because a single narration costs a fraction
    # of a cent; see app/llm/base.py.
    assert _guard(FakeRedis(), "5").cap_micro_usd == 5 * MICRO_USD_PER_USD


async def test_a_call_under_the_cap_is_allowed_and_charged():
    redis = FakeRedis()
    guard = _guard(redis, "1")
    inner = _StubProvider(cost_micro_usd=250_000)

    await _complete(BudgetedProvider(inner, guard))

    assert inner.calls == 1
    assert await guard.spent_micro_usd() == 250_000


async def test_the_budget_refuses_once_the_day_is_spent():
    redis = FakeRedis()
    guard = _guard(redis, "1")
    inner = _StubProvider(cost_micro_usd=400_000)
    provider = BudgetedProvider(inner, guard)

    # Three calls fit inside a dollar; the fourth is refused because the recorded
    # spend has reached the cap. The cap is checked before a call and charged
    # after it, so it can be overshot by at most one call - deliberately, see
    # app/llm/budget.py.
    for _ in range(3):
        await _complete(provider)
    with pytest.raises(LLMBudgetExceededError) as raised:
        await _complete(provider)

    assert inner.calls == 3  # the refused call never reached the provider
    assert raised.value.cap_micro_usd == guard.cap_micro_usd
    assert raised.value.spent_micro_usd == 1_200_000


async def test_the_budget_resets_the_next_utc_day(monkeypatch):
    day = {"value": datetime(2026, 9, 15, 23, 50, tzinfo=UTC)}

    class FrozenDatetime:
        @staticmethod
        def now(tz=None):
            return day["value"]

    monkeypatch.setattr("app.llm.budget.datetime", FrozenDatetime)
    guard = _guard(FakeRedis(), "1")
    provider = BudgetedProvider(_StubProvider(cost_micro_usd=MICRO_USD_PER_USD), guard)

    await _complete(provider)
    with pytest.raises(LLMBudgetExceededError):
        await _complete(provider)

    day["value"] = datetime(2026, 9, 16, 0, 5, tzinfo=UTC)
    await _complete(provider)  # a new day, a new budget
    assert await guard.spent_micro_usd() == MICRO_USD_PER_USD


async def test_a_zero_cap_permits_no_paid_call():
    # The opposite of the rate limiter's convention on purpose: an unset spend
    # ceiling must not read as "unlimited".
    inner = _StubProvider()
    with pytest.raises(LLMBudgetExceededError):
        await _complete(BudgetedProvider(inner, _guard(FakeRedis(), "0")))
    assert inner.calls == 0


async def test_a_fractional_cap_is_floored_rather_than_rounded_up():
    assert _guard(FakeRedis(), "0.0000005").cap_micro_usd == 0


# -- what happens around a failure --------------------------------------------


async def test_spend_on_a_failed_call_is_still_recorded():
    # An answer that arrived and could not be used still burned the prompt. A
    # charge nobody wrote down is worse than a charge.
    redis = FakeRedis()
    guard = _guard(redis, "1")
    failure = LLMRequestError("stub", "no completion text", metered_micro_usd=7_000)
    provider = BudgetedProvider(_StubProvider(error=failure), guard)

    with pytest.raises(LLMRequestError):
        await _complete(provider)

    assert await guard.spent_micro_usd() == 7_000


async def test_a_failure_that_cost_nothing_charges_nothing():
    guard = _guard(FakeRedis(), "1")
    provider = BudgetedProvider(_StubProvider(error=LLMRequestError("stub", "HTTP 400")), guard)

    with pytest.raises(LLMRequestError):
        await _complete(provider)

    assert await guard.spent_micro_usd() == 0


async def test_an_unreadable_counter_fails_closed():
    # If the counter cannot be read, assuming "nothing spent" would uncap the day.
    redis = FakeRedis()
    guard = _guard(redis, "1")
    await redis.set("traders:llm:spend:" + datetime.now(UTC).strftime("%Y-%m-%d"), "corrupt")

    assert await guard.spent_micro_usd() == guard.cap_micro_usd
    with pytest.raises(LLMBudgetExceededError):
        await _complete(BudgetedProvider(_StubProvider(), guard))


# -- providers that are not metered -------------------------------------------


async def test_a_local_provider_bypasses_the_budget_entirely():
    # Local inference costs electricity, not API credit, so a zero cap must not
    # disable it - mirroring the rate limiter skipping the fixture provider.
    inner = _LocalStub()
    guard = _guard(FakeRedis(), "0")

    await _complete(BudgetedProvider(inner, guard))

    assert inner.calls == 1
    assert await guard.spent_micro_usd() == 0
