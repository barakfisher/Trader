"""Per-provider outbound rate limiting.

Fixed-window counters in Redis, keyed by provider. Simpler than a true token
bucket and sufficient for our purpose: refusing to burn a free tier's quota in
one runaway loop. `allow` never blocks; callers that are denied fall through to
the next provider in the chain.

Two windows, because free tiers are capped on two axes:

  * per minute (`allow`) - the burst guard;
  * per UTC day (`allow_daily`) - the one that actually matters for Alpha
    Vantage's 25 requests/day. A per-minute limiter cannot protect a daily cap:
    24 requests an hour is comfortably inside 60/minute and still 23x over
    budget by midnight.

Cost is explicit rather than assumed. A provider that issues one HTTP request
per symbol spends `len(symbols)` of its budget on a call the limiter used to
charge 1 for, which under-reported usage by the batch size - a 10-symbol
portfolio looked like one request out of 60.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime

from redis.asyncio import Redis

from app.core.logging import get_logger

log = get_logger("ratelimit")

#: Comfortably past the end of the minute the key belongs to, so a clock skew or
#: a slow request cannot resurrect an expired window as a fresh one.
_MINUTE_KEY_TTL_SECONDS = 120

#: Daily keys expire a day late on purpose: a key that outlives its own date is
#: harmless (nothing reads it again) whereas one that expires early hands back a
#: quota the provider has not restored.
_DAILY_KEY_TTL_SECONDS = 48 * 3600


class RateLimiter:
    def __init__(self, redis: Redis, *, namespace: str = "traders:rl") -> None:
        self._redis = redis
        self._ns = namespace

    async def allow(self, provider: str, limit_per_minute: int, cost: int = 1) -> bool:
        """Charge `cost` requests to this minute's window; False when over budget.

        The charge lands whether or not the answer is True. Refunding it would
        take a second round trip and, for our purpose, over-counting a denied
        call is the safe direction to be wrong in.
        """
        if limit_per_minute <= 0 or cost <= 0:
            return True
        bucket = int(time.time() // 60)
        key = f"{self._ns}:{provider}:{bucket}"
        count = await self._redis.incrby(key, cost)
        if count == cost:  # first charge in this window
            await self._redis.expire(key, _MINUTE_KEY_TTL_SECONDS)
        allowed = count <= limit_per_minute
        if not allowed:
            log.warning("ratelimit.denied", provider=provider, count=count, limit=limit_per_minute)
        return allowed

    async def allow_daily(self, provider: str, limit_per_day: int, cost: int = 1) -> bool:
        """Same, against the provider's UTC-day budget. 0 or less means uncapped.

        The day is UTC rather than APP_TIMEZONE because it models the provider's
        own reset, not the user's day, and the providers we care about reset on
        UTC midnight.
        """
        if limit_per_day <= 0 or cost <= 0:
            return True
        day = datetime.now(UTC).strftime("%Y-%m-%d")
        key = f"{self._ns}:{provider}:day:{day}"
        count = await self._redis.incrby(key, cost)
        if count == cost:
            await self._redis.expire(key, _DAILY_KEY_TTL_SECONDS)
        allowed = count <= limit_per_day
        if not allowed:
            log.warning(
                "ratelimit.daily_budget_exhausted",
                provider=provider,
                day=day,
                count=count,
                limit=limit_per_day,
            )
        return allowed
