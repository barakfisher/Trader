"""The daily spend ceiling, and the wrapper that enforces it.

LLM_DAILY_BUDGET_USD is the only thing standing between a scheduled pipeline and
an open-ended bill: a run loop that narrates every finding, retried on a cron,
can spend real money overnight with nobody watching. So the cap is enforced in
code rather than trusted to a vendor dashboard.

The mechanism is the fixed-window counter from `core/ratelimit.py`, with the
window set to a UTC day and the counted unit set to estimated micro-USD instead
of requests. UTC rather than APP_TIMEZONE for the same reason the rate limiter
uses it: this models the provider's own billing day, not the user's day.

Three properties are deliberate:

  * **Check before, record after.** The cost of a call is unknown until the
    response reports its token usage, so the guard admits a call while the day's
    recorded spend is under the cap and charges the real estimate afterwards.
    The cap can therefore be overshot by at most one call, which at narration
    sizes is a fraction of a cent. Reserving a worst-case amount up front and
    refunding the difference was the alternative: it costs a second round trip
    per call and turns every crashed process into a permanently leaked
    reservation.
  * **A failed call still records what it burned.** `LLMError.metered_micro_usd`
    carries spend that happened despite the failure; it is recorded before the
    error propagates. A charge nobody wrote down is worse than a charge.
  * **A breach is loud.** It logs at warning level and raises
    `LLMBudgetExceededError`. The caller's contract is to degrade to rule-based
    observations without narration - never to continue quietly, and never to
    produce half a narration.

A provider that does not charge per token (Ollama) bypasses all of this, the way
the rate limiter skips a provider with no upstream quota to protect.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import ROUND_FLOOR, Decimal

from redis.asyncio import Redis

from app.core.logging import get_logger
from app.llm.base import (
    MICRO_USD_PER_USD,
    Caller,
    LLMBudgetExceededError,
    LLMCompletion,
    LLMError,
    LLMProvider,
    Verdict,
)

log = get_logger("llm.budget")

#: Same reasoning as the rate limiter's daily key: a counter that outlives its
#: own date is harmless because nothing reads it again, whereas one that expires
#: early hands back budget the month's invoice has not forgotten.
_DAILY_KEY_TTL_SECONDS = 48 * 3600


class DailySpendGuard:
    """Tracks estimated LLM spend per UTC day and says when the cap is reached."""

    def __init__(
        self,
        redis: Redis,
        cap_usd: Decimal,
        *,
        namespace: str = "traders:llm",
    ) -> None:
        # Floor rather than round: a cap of 4.9999 USD should not admit spend
        # up to 5.
        self._cap_micro_usd = int(
            (Decimal(cap_usd) * MICRO_USD_PER_USD).to_integral_value(rounding=ROUND_FLOOR)
        )
        self._redis = redis
        self._ns = namespace

    @property
    def cap_micro_usd(self) -> int:
        return self._cap_micro_usd

    @staticmethod
    def _today() -> str:
        return datetime.now(UTC).strftime("%Y-%m-%d")

    def _key(self, day: str) -> str:
        return f"{self._ns}:spend:{day}"

    async def spent_micro_usd(self, day: str | None = None) -> int:
        raw = await self._redis.get(self._key(day or self._today()))
        if raw is None:
            return 0
        try:
            return int(raw)
        except (TypeError, ValueError):
            # A corrupt counter must not read as "nothing spent today"; treating
            # it as a full day's spend fails closed until midnight, which is the
            # direction a spend guard should fail in.
            log.error("llm.budget_counter_unreadable", value=str(raw))
            return self._cap_micro_usd

    async def ensure_within_budget(self) -> None:
        """Raise `LLMBudgetExceededError` when today's cap is already reached.

        A cap of zero or less means no paid call is permitted. This is the
        opposite of the rate limiter's convention, where 0 means "uncapped", and
        the difference is intentional: an unset or mistyped LLM_DAILY_BUDGET_USD
        reading as "spend without limit" is the single worst way for this
        setting to fail. Unlimited spend is not expressible here, by design -
        raise the number.
        """
        day = self._today()
        if self._cap_micro_usd <= 0:
            log.warning("llm.budget_disabled", day=day, cap_usd="0")
            raise LLMBudgetExceededError(0, self._cap_micro_usd, day)
        spent = await self.spent_micro_usd(day)
        if spent >= self._cap_micro_usd:
            log.warning(
                "llm.budget_exhausted",
                day=day,
                spent_micro_usd=spent,
                cap_micro_usd=self._cap_micro_usd,
            )
            raise LLMBudgetExceededError(spent, self._cap_micro_usd, day)

    async def record(self, micro_usd: int) -> int:
        """Charge `micro_usd` to today's window and return the new total."""
        if micro_usd <= 0:
            return await self.spent_micro_usd()
        key = self._key(self._today())
        total = await self._redis.incrby(key, micro_usd)
        if total == micro_usd:  # first charge of this day
            await self._redis.expire(key, _DAILY_KEY_TTL_SECONDS)
        return total


class BudgetedProvider:
    """Wraps any `LLMProvider` with the daily spend guard.

    A wrapper rather than a base class or a mixin, so that the adapters stay
    pure transport and a new adapter inherits the guard by being constructed,
    not by remembering to call something. See factory.py, which is the only
    place either is assembled.
    """

    def __init__(self, inner: LLMProvider, guard: DailySpendGuard) -> None:
        self._inner = inner
        self._guard = guard
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
        if not self.charges_per_token:
            return await self._inner.complete(
                system=system,
                user=user,
                max_output_tokens=max_output_tokens,
                temperature=temperature,
                reasoning_effort=reasoning_effort,
                caller=caller,
                model=model,
            )

        await self._guard.ensure_within_budget()
        try:
            completion = await self._inner.complete(
                system=system,
                user=user,
                max_output_tokens=max_output_tokens,
                temperature=temperature,
                reasoning_effort=reasoning_effort,
                caller=caller,
                model=model,
            )
        except LLMError as exc:
            if exc.metered_micro_usd > 0:
                total = await self._guard.record(exc.metered_micro_usd)
                log.warning(
                    "llm.spend_on_failed_call",
                    provider=self.name,
                    estimated_cost_micro_usd=exc.metered_micro_usd,
                    day_total_micro_usd=total,
                )
            raise

        total = await self._guard.record(completion.estimated_cost_micro_usd)
        # The per-call spend line. Estimated, per pricing.py, and named as such
        # so nobody reconciles it against an invoice and concludes the code is
        # wrong. Emitted here rather than in the adapter because this is the only
        # place that knows the running daily total.
        log.info(
            "llm.spend",
            provider=self.name,
            model=completion.model,
            prompt_tokens=completion.usage.prompt_tokens,
            completion_tokens=completion.usage.completion_tokens,
            estimated_cost_micro_usd=completion.estimated_cost_micro_usd,
            day_total_micro_usd=total,
            cap_micro_usd=self._guard.cap_micro_usd,
        )
        return completion

    async def record_verdict(self, call_id: int | None, verdict: Verdict) -> None:
        await self._inner.record_verdict(call_id, verdict)
