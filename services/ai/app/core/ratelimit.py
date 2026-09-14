"""Per-provider outbound rate limiting.

A fixed-window counter in Redis, keyed by provider and minute bucket. Simpler
than a true token bucket and sufficient for our purpose: refusing to burn a free
tier's daily quota in one runaway loop. `allow` never blocks; callers that are
denied fall through to the next provider in the chain.
"""

from __future__ import annotations

import time

from redis.asyncio import Redis

from app.core.logging import get_logger

log = get_logger("ratelimit")


class RateLimiter:
    def __init__(self, redis: Redis, *, namespace: str = "traders:rl") -> None:
        self._redis = redis
        self._ns = namespace

    async def allow(self, provider: str, limit_per_minute: int) -> bool:
        if limit_per_minute <= 0:
            return True
        bucket = int(time.time() // 60)
        key = f"{self._ns}:{provider}:{bucket}"
        count = await self._redis.incr(key)
        if count == 1:
            await self._redis.expire(key, 120)
        allowed = count <= limit_per_minute
        if not allowed:
            log.warning("ratelimit.denied", provider=provider, count=count, limit=limit_per_minute)
        return allowed
