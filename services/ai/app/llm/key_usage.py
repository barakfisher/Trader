"""What OpenRouter says a user's own key has spent, for the spend indicator (D247-D249, D281).

`GET /key` describes the key that asks: its credit `limit` and `limit_remaining`
(null for an unlimited key), how the limit resets (`limit_reset`), and its spend
in calendar windows in UTC - `usage_daily` (today), `usage_weekly` (since Monday)
and `usage_monthly` (this month). Every figure counts the whole key, so spend by
other apps on the same key is in it, which is why the indicator reads OpenRouter
and not this app's own `llm_calls` (D248). The call is free.

**Read when a page asks, cached 15 minutes per user** (D249): an idle app makes
no calls, an active user at most four an hour. The cache key carries the saved
key's state - when it was saved, and whether and when it failed - so a key
replaced, removed or refused since is read again at once rather than shown stale.

Amounts arrive as JSON numbers of dollars. They are parsed as `Decimal` and
rounded once, here, to integer micro-USD (guideline 3).
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Protocol

import httpx

from app.core.logging import get_logger

log = get_logger("llm.key_usage")

#: How long one reading of a user's key is shown before OpenRouter is asked again (D249).
KEY_USAGE_TTL_SECONDS = 15 * 60

_READ_TIMEOUT_SECONDS = 10.0
_MICRO = Decimal(1_000_000)


@dataclass(frozen=True)
class KeyUsage:
    """One reading of `GET /key`, in integer micro-USD."""

    limit_micro_usd: int | None
    limit_remaining_micro_usd: int | None
    #: As OpenRouter names it ("daily", "weekly", "monthly"), or None when it never resets.
    limit_reset: str | None
    usage_daily_micro_usd: int
    usage_weekly_micro_usd: int
    usage_monthly_micro_usd: int
    read_at: datetime


class KeyUsageReader(Protocol):
    async def read(self, api_key: str) -> KeyUsage | None:
        """OpenRouter's description of the key, or None when it cannot be read. Never raises."""
        ...


def _micro(value: object) -> int | None:
    if value is None:
        return None
    amount = value if isinstance(value, Decimal) else Decimal(str(value))
    return int((amount * _MICRO).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def parse_key_usage(body: dict[str, object], read_at: datetime) -> KeyUsage | None:
    """`GET /key`'s `data`, or None when it is not the shape OpenRouter documents."""
    data = body.get("data")
    if not isinstance(data, dict):
        return None
    try:
        reset = data.get("limit_reset")
        return KeyUsage(
            limit_micro_usd=_micro(data.get("limit")),
            limit_remaining_micro_usd=_micro(data.get("limit_remaining")),
            limit_reset=str(reset) if reset else None,
            usage_daily_micro_usd=_micro(data.get("usage_daily")) or 0,
            usage_weekly_micro_usd=_micro(data.get("usage_weekly")) or 0,
            usage_monthly_micro_usd=_micro(data.get("usage_monthly")) or 0,
            read_at=read_at,
        )
    except (ArithmeticError, ValueError, TypeError):
        return None


class OpenRouterKeyUsageReader:
    """`GET {base}/key` with the user's own key."""

    def __init__(self, base_url: str, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._url = f"{base_url.rstrip('/')}/key"
        self._transport = transport

    async def read(self, api_key: str) -> KeyUsage | None:
        try:
            async with httpx.AsyncClient(
                timeout=_READ_TIMEOUT_SECONDS, transport=self._transport
            ) as client:
                # Sent to the provider it belongs to; logged nowhere (guideline 9).
                response = await client.get(
                    self._url, headers={"authorization": f"Bearer {api_key}"}
                )
        except httpx.HTTPError as error:
            log.warning("llm.key_usage_unreachable", error=type(error).__name__)
            return None
        if response.status_code != 200:
            log.warning("llm.key_usage_refused", status=response.status_code)
            return None
        try:
            body = json.loads(response.text, parse_float=Decimal)
        except ValueError:
            return None
        usage = parse_key_usage(body, datetime.now(UTC)) if isinstance(body, dict) else None
        if usage is None:
            log.warning("llm.key_usage_unexpected_shape")
        return usage


class KeyUsageCache(Protocol):
    async def get(self, key: str) -> str | None: ...

    async def set(self, key: str, value: str, ex: int) -> object: ...


def cache_key(user_id: str, key_state: str) -> str:
    return f"llm:key_usage:{user_id}:{key_state}"


async def cached_key_usage(
    cache: KeyUsageCache | None,
    reader: KeyUsageReader,
    *,
    user_id: str,
    key_state: str,
    api_key: str,
) -> KeyUsage | None:
    """The cached reading for this key's state, or a fresh one. A cache that fails is skipped."""
    key = cache_key(user_id, key_state)
    if cache is not None:
        try:
            hit = await cache.get(key)
        except Exception as error:  # noqa: BLE001 - a reading without the cache still serves
            log.warning("llm.key_usage_cache_unreadable", error=str(error))
            hit = None
        if hit is not None:
            stored = json.loads(hit)
            stored["read_at"] = datetime.fromisoformat(stored["read_at"])
            return KeyUsage(**stored)
    usage = await reader.read(api_key)
    if usage is not None and cache is not None:
        record = {**asdict(usage), "read_at": usage.read_at.isoformat()}
        try:
            await cache.set(key, json.dumps(record), ex=KEY_USAGE_TTL_SECONDS)
        except Exception as error:  # noqa: BLE001
            log.warning("llm.key_usage_cache_unwritable", error=str(error))
    return usage
