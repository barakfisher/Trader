"""A user's monthly limit on model spend, enforced before every call: their safety limit (D250).

Written for the admin-set monthly cap (D157, D158), which bounded what the
installation paid for each user. Since D245 no user but the admin runs on the
installation's key, so that cap has nothing to bound and is retired (D279): its
column stays, unread. **The limit this module enforces now is the user's own
optional safety limit on their key** (`user_settings.llm_safety_limit_micro_usd`),
a brake against a runaway loop that binds even a key with no OpenRouter limit.

**The month is the user's calendar month, in `users.timezone`**, and spent is
`sum(llm_calls.cost_micro_usd)` for the user since it began, over the calls made
on their own key (`paid_by = 'own_key'`, D209) - `llm_calls` is already the
ledger of every call, refused ones included, so there is no second counter to
drift from it. That holds only while the log keeps a whole month, which is why
`LLM_CALL_RETENTION_DAYS` may not be set below `MIN_RETENTION_DAYS` (D204).

**Checked before each call, tool loops included.** A call's cost is known after
it returns, so the honest form of strict is to refuse when spent plus the most
the call can cost would pass the limit: its prompt's characters at the input
price and every token it may write at the output price
(`pricing.ceiling_cost_micro_usd`). Two calls of the same user checked at the
same instant can both pass; the overshoot is bounded by one call.

A refusal raises `MonthlyCapReachedError`, a kind of `LLMBudgetExceededError`:
narration falls back to its template and the instructions check skips, as
they do for a spent budget, and an agent scan or an `/ask` turn ends as
`cap_reached`, which the screens explain as the safety limit with its reset date.

The wrapper sits around the user's own-key adapter (`factory.py`), inside the
recorder, so a refused call is recorded - at no cost, as `budget_exhausted`.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Protocol
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.core.logging import get_logger
from app.llm.base import (
    AssistantMessage,
    Caller,
    LLMCompletion,
    LLMProvider,
    Message,
    MonthlyCapReachedError,
    ToolResultMessage,
    ToolSpec,
    UserMessage,
    Verdict,
)
from app.llm.pricing import ModelPrice, ceiling_cost_micro_usd

log = get_logger("llm.monthly_cap")

#: The shortest call log that still holds a whole month in any time zone: 31
#: days plus a day for the zone's offset from UTC (D204).
MIN_RETENTION_DAYS = 32


def month_bounds(now: datetime, timezone: str) -> tuple[datetime, datetime]:
    """The user's calendar month around `now`: its first instant and the next month's, in UTC."""
    zone = ZoneInfo(timezone)
    local = now.astimezone(zone)
    start = local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    year, month = (local.year + 1, 1) if local.month == 12 else (local.year, local.month + 1)
    following = start.replace(year=year, month=month)
    return start.astimezone(UTC), following.astimezone(UTC)


@dataclass(frozen=True)
class CapMonth:
    """One limited user's month: the limit, what is spent, and when it starts again."""

    cap_micro_usd: int
    spent_micro_usd: int
    resets_at: datetime


class CapLedger(Protocol):
    def month(self, user_id: str, now: datetime) -> CapMonth | None:
        """The user's month, or None when the user has set no limit. May raise."""
        ...


class DatabaseSafetyLimitLedger:
    """`user_settings` for the limit, `users` for the zone, `llm_calls` for own-key spend."""

    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def month(self, user_id: str, now: datetime) -> CapMonth | None:
        with self._engine.connect() as connection:
            user = connection.execute(
                text(
                    """
                    SELECT s.llm_safety_limit_micro_usd AS cap, u.timezone
                      FROM users u
                      LEFT JOIN user_settings s ON s.user_id = u.id
                     WHERE u.id = CAST(:user AS uuid)
                    """
                ),
                {"user": user_id},
            ).one_or_none()
            if user is None or user.cap is None:
                return None
            start, resets_at = month_bounds(now, user.timezone)
            spent = connection.execute(
                text(
                    """
                    SELECT coalesce(sum(cost_micro_usd), 0) FROM llm_calls
                     WHERE user_id = CAST(:user AS uuid) AND started_at >= :since
                       AND paid_by = 'own_key'
                    """
                ),
                {"user": user_id, "since": start},
            ).scalar_one()
        return CapMonth(int(user.cap), int(spent), resets_at)


def prompt_chars(system: str | None, messages: Sequence[Message], tools: Sequence[ToolSpec]) -> int:
    """Every character a call sends the model: the system prompt, each message
    and tool call, and the tools' descriptions and schemas."""
    total = len(system or "")
    for message in messages:
        if isinstance(message, UserMessage):
            total += len(message.text)
        elif isinstance(message, AssistantMessage):
            total += len(message.text)
            total += sum(len(call.name) + len(call.arguments) for call in message.tool_calls)
        elif isinstance(message, ToolResultMessage):
            total += len(message.content)
    for tool in tools:
        total += len(tool.name) + len(tool.description) + len(json.dumps(tool.parameters))
    return total


class MonthlyCapProvider:
    """Refuses a call that would take its user past their monthly limit."""

    def __init__(
        self,
        inner: LLMProvider,
        ledger: CapLedger,
        *,
        model: str,
        prices: dict[str, ModelPrice],
        unknown_price_usd_per_mtok: Decimal,
        max_output_tokens: int,
    ) -> None:
        self._inner = inner
        self._ledger = ledger
        #: The configured model, for a call that names none.
        self._model = model
        self._prices = prices
        self._unknown_price = unknown_price_usd_per_mtok
        #: The adapter's own default, for a call that sets no ceiling.
        self._max_output_tokens = max_output_tokens
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
        self._check(
            caller,
            model=model,
            chars=prompt_chars(system, [UserMessage(user)], []),
            max_output_tokens=max_output_tokens,
        )
        return await self._inner.complete(
            system=system,
            user=user,
            max_output_tokens=max_output_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            caller=caller,
            model=model,
        )

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
        self._check(
            caller,
            model=model,
            chars=prompt_chars(system, messages, tools),
            max_output_tokens=max_output_tokens,
        )
        return await self._inner.converse(
            system=system,
            messages=messages,
            tools=tools,
            max_output_tokens=max_output_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            caller=caller,
            model=model,
        )

    def _check(
        self,
        caller: Caller | None,
        *,
        model: str | None,
        chars: int,
        max_output_tokens: int | None,
    ) -> None:
        """Raise `MonthlyCapReachedError` when this call could pass the user's limit.

        A call for no user, a user without a limit, and a provider that does not
        charge per token are never refused. A ledger that cannot be read fails
        closed: the limit exists to bound a bill, and "unknown" read as "nothing
        spent" is the expensive direction to be wrong in.
        """
        if caller is None or caller.user_id is None or not self.charges_per_token:
            return
        now = datetime.now(UTC)
        try:
            month = self._ledger.month(caller.user_id, now)
        except Exception as error:
            log.error("llm.monthly_cap_unreadable", user_id=caller.user_id, error=str(error))
            raise MonthlyCapReachedError(0, 0, 0, now) from error
        if month is None:
            return
        estimate = ceiling_cost_micro_usd(
            model or self._model,
            chars,
            max_output_tokens or self._max_output_tokens,
            self._prices,
            unknown_price_usd_per_mtok=self._unknown_price,
        )
        if month.spent_micro_usd + estimate > month.cap_micro_usd:
            log.warning(
                "llm.monthly_cap_reached",
                user_id=caller.user_id,
                purpose=caller.purpose,
                spent_micro_usd=month.spent_micro_usd,
                estimate_micro_usd=estimate,
                cap_micro_usd=month.cap_micro_usd,
            )
            raise MonthlyCapReachedError(
                month.spent_micro_usd, month.cap_micro_usd, estimate, month.resets_at
            )

    async def record_verdict(self, call_id: int | None, verdict: Verdict) -> None:
        await self._inner.record_verdict(call_id, verdict)
