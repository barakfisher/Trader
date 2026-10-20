"""The monthly cap (D157, D158, D202): checked before each call, keyed by the caller's user.

The ledger is a fake here; `tests/integration/test_monthly_cap_sql.py` reads
the real `users` and `llm_calls`.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from app.config import Settings
from app.llm.base import (
    Caller,
    LLMBudgetExceededError,
    LLMCompletion,
    MonthlyCapReachedError,
    TokenUsage,
    ToolSpec,
    UserMessage,
)
from app.llm.call_log import CallEntry
from app.llm.factory import build_llm
from app.llm.monthly_cap import (
    MIN_RETENTION_DAYS,
    CapMonth,
    MonthlyCapProvider,
    month_bounds,
    prompt_chars,
)
from app.llm.pricing import (
    DEFAULT_UNKNOWN_MODEL_PRICE_USD_PER_MTOK,
    FREE_MODEL_SUFFIX,
    ModelPrice,
    ceiling_cost_micro_usd,
)
from tests.fakes import FakeRedis

PRICED = "vendor/priced"
PRICES = {PRICED: ModelPrice(Decimal("2"), Decimal("10"))}
MAX_OUTPUT = 700
RESETS = datetime(2026, 10, 31, 22, tzinfo=UTC)
USER = "00000000-0000-0000-0000-0000000000c1"


class _Ledger:
    def __init__(self, month: CapMonth | None = None, error: Exception | None = None) -> None:
        self._month = month
        self._error = error
        self.asked: list[str] = []

    def month(self, user_id: str, now: datetime) -> CapMonth | None:
        self.asked.append(user_id)
        if self._error is not None:
            raise self._error
        return self._month


class _Inner:
    name = "stub"

    def __init__(self, charges_per_token: bool = True) -> None:
        self.charges_per_token = charges_per_token
        self.calls = 0

    async def complete(self, **_: Any) -> LLMCompletion:
        self.calls += 1
        return LLMCompletion("ok", PRICED, TokenUsage(1, 1), 1, self.name)

    async def converse(self, **_: Any) -> LLMCompletion:
        return await self.complete()

    async def record_verdict(self, call_id: int | None, verdict: str) -> None:
        return None


def _capped(ledger: _Ledger, inner: _Inner | None = None) -> tuple[MonthlyCapProvider, _Inner]:
    inner = inner or _Inner()
    provider = MonthlyCapProvider(
        inner,
        ledger,
        model=PRICED,
        prices=PRICES,
        unknown_price_usd_per_mtok=DEFAULT_UNKNOWN_MODEL_PRICE_USD_PER_MTOK,
        max_output_tokens=MAX_OUTPUT,
    )
    return provider, inner


def _ceiling(user: str, model: str = PRICED, max_output: int = MAX_OUTPUT) -> int:
    return ceiling_cost_micro_usd(model, len(user), max_output, PRICES)


# -- the month ------------------------------------------------------------------


def test_the_month_is_the_users_calendar_month_in_their_zone() -> None:
    # 22:30 UTC on 31 October is already 1 November in Jerusalem (UTC+2 in winter).
    start, following = month_bounds(datetime(2026, 10, 31, 22, 30, tzinfo=UTC), "Asia/Jerusalem")
    assert start == datetime(2026, 10, 31, 22, tzinfo=UTC)
    assert following == datetime(2026, 11, 30, 22, tzinfo=UTC)


def test_december_rolls_into_the_next_year() -> None:
    start, following = month_bounds(datetime(2026, 12, 15, tzinfo=UTC), "UTC")
    assert (start, following) == (
        datetime(2026, 12, 1, tzinfo=UTC),
        datetime(2027, 1, 1, tzinfo=UTC),
    )


def test_the_call_log_keeps_at_least_a_month() -> None:
    assert Settings(_env_file=None, app_env="test").llm_call_retention_days >= MIN_RETENTION_DAYS
    with pytest.raises(ValidationError):
        Settings(_env_file=None, app_env="test", llm_call_retention_days=MIN_RETENTION_DAYS - 1)


# -- the check ------------------------------------------------------------------


async def test_a_call_that_fits_under_the_cap_is_made() -> None:
    cap = _ceiling("q")
    provider, inner = _capped(_Ledger(CapMonth(cap, 0, RESETS)))
    await provider.complete(system=None, user="q", caller=Caller("ask", user_id=USER))
    assert inner.calls == 1


async def test_a_call_that_could_pass_the_cap_is_refused_before_it_is_made() -> None:
    cap = _ceiling("q")
    provider, inner = _capped(_Ledger(CapMonth(cap, 1, RESETS)))
    with pytest.raises(MonthlyCapReachedError) as refused:
        await provider.complete(system=None, user="q", caller=Caller("ask", user_id=USER))
    assert inner.calls == 0
    assert refused.value.resets_at == RESETS
    assert (refused.value.spent_micro_usd, refused.value.cap_micro_usd) == (1, cap)
    # Every caller that degrades on a spent budget degrades on this one too.
    assert isinstance(refused.value, LLMBudgetExceededError)


async def test_the_calls_own_output_ceiling_and_model_are_priced() -> None:
    cap = _ceiling("q")
    provider, inner = _capped(_Ledger(CapMonth(cap, 0, RESETS)))
    with pytest.raises(MonthlyCapReachedError):
        await provider.complete(
            system=None,
            user="q",
            max_output_tokens=MAX_OUTPUT + 1,
            caller=Caller("ask", user_id=USER),
        )
    with pytest.raises(MonthlyCapReachedError):
        await provider.complete(
            system=None, user="q", caller=Caller("ask", user_id=USER), model="vendor/unpriced"
        )
    assert inner.calls == 0


async def test_a_free_model_costs_nothing_against_the_cap() -> None:
    provider, inner = _capped(_Ledger(CapMonth(1, 1, RESETS)))
    await provider.complete(
        system=None, user="q", caller=Caller("ask", user_id=USER), model=f"x/y{FREE_MODEL_SUFFIX}"
    )
    assert inner.calls == 1


async def test_a_turn_of_a_tool_loop_is_priced_with_its_whole_conversation() -> None:
    tool = ToolSpec("look", "Looks.", {"type": "object"})
    messages = [UserMessage("q"), UserMessage("more")]
    chars = prompt_chars("system", messages, [tool])
    assert chars > len("system") + len("q") + len("more")
    cap = ceiling_cost_micro_usd(PRICED, chars, MAX_OUTPUT, PRICES)
    caller = Caller("agent_scan", user_id=USER)

    fits, inner = _capped(_Ledger(CapMonth(cap, 0, RESETS)))
    await fits.converse(system="system", messages=messages, tools=[tool], caller=caller)
    assert inner.calls == 1

    over, inner = _capped(_Ledger(CapMonth(cap - 1, 0, RESETS)))
    with pytest.raises(MonthlyCapReachedError):
        await over.converse(system="system", messages=messages, tools=[tool], caller=caller)
    assert inner.calls == 0


async def test_a_user_without_a_cap_is_never_refused() -> None:
    provider, inner = _capped(_Ledger(None))
    await provider.complete(system=None, user="q", caller=Caller("ask", user_id=USER))
    assert inner.calls == 1


async def test_a_call_for_no_user_or_on_an_unmetered_provider_is_not_checked() -> None:
    ledger = _Ledger(CapMonth(0, 0, RESETS))
    provider, inner = _capped(ledger)
    await provider.complete(system=None, user="q", caller=Caller("narration"))
    local, local_inner = _capped(ledger, _Inner(charges_per_token=False))
    await local.complete(system=None, user="q", caller=Caller("ask", user_id=USER))
    assert (inner.calls, local_inner.calls, ledger.asked) == (1, 1, [])


async def test_a_ledger_that_cannot_be_read_refuses_the_call() -> None:
    provider, inner = _capped(_Ledger(error=RuntimeError("database down")))
    with pytest.raises(MonthlyCapReachedError):
        await provider.complete(system=None, user="q", caller=Caller("ask", user_id=USER))
    assert inner.calls == 0


# -- assembled ------------------------------------------------------------------


class _Log:
    def __init__(self) -> None:
        self.entries: list[CallEntry] = []

    def record(self, entry: CallEntry) -> int:
        self.entries.append(entry)
        return len(self.entries)

    def set_verdict(self, call_id: int, verdict: str) -> None:
        return None


async def test_the_factory_checks_the_cap_inside_the_recorder() -> None:
    def unreachable(request: httpx.Request) -> httpx.Response:
        raise AssertionError("a refused call reached the network")

    log = _Log()
    provider = build_llm(
        Settings(
            _env_file=None,
            app_env="test",
            llm_provider="openrouter",
            openrouter_api_key="k",
            llm_model=PRICED,
        ),
        FakeRedis(),
        transport=httpx.MockTransport(unreachable),
        call_log=log,
        cap_ledger=_Ledger(CapMonth(0, 0, RESETS)),
    )
    with pytest.raises(MonthlyCapReachedError):
        await provider.complete(system=None, user="q", caller=Caller("ask", user_id=USER))
    [entry] = log.entries
    assert (entry.outcome, entry.cost_micro_usd, entry.user_id) == ("budget_exhausted", 0, USER)
