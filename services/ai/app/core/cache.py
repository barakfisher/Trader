"""Redis-backed JSON cache with single-flight protection.

Provider quotas are the scarcest resource in this system, so every outbound
provider call is cached. `get_or_set` collapses concurrent misses for the same
key onto one upstream call: the loser of the lock waits briefly and re-reads the
cache instead of issuing a duplicate request.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

from redis.asyncio import Redis

from app.core.logging import get_logger

log = get_logger("cache")

_LOCK_TTL_SECONDS = 10
_LOCK_WAIT_SECONDS = 0.1
_LOCK_MAX_WAITS = 50


class Cache:
    def __init__(self, redis: Redis, *, namespace: str = "traders") -> None:
        self._redis = redis
        self._ns = namespace

    def _key(self, key: str) -> str:
        return f"{self._ns}:{key}"

    async def get(self, key: str) -> Any | None:
        raw = await self._redis.get(self._key(key))
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            # A corrupt entry is never worth an outage; drop it and treat as a miss.
            await self._redis.delete(self._key(key))
            return None

    async def set(self, key: str, value: Any, ttl_seconds: int) -> None:
        await self._redis.set(self._key(key), json.dumps(value, default=str), ex=ttl_seconds)

    async def get_or_set(
        self,
        key: str,
        ttl_seconds: int,
        producer: Callable[[], Awaitable[Any]],
    ) -> Any:
        cached = await self.get(key)
        if cached is not None:
            return cached

        lock_key = self._key(f"lock:{key}")
        got_lock = await self._redis.set(lock_key, "1", ex=_LOCK_TTL_SECONDS, nx=True)
        if not got_lock:
            for _ in range(_LOCK_MAX_WAITS):
                await asyncio.sleep(_LOCK_WAIT_SECONDS)
                cached = await self.get(key)
                if cached is not None:
                    return cached
            log.warning("cache.single_flight_timeout", key=key)
            return await producer()

        try:
            value = await producer()
            if value is not None:
                await self.set(key, value, ttl_seconds)
            return value
        finally:
            await self._redis.delete(lock_key)
