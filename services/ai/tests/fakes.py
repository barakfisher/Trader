"""In-memory stand-ins for infrastructure, so the unit suite needs no services.

Only the handful of Redis commands our cache and rate limiter actually use are
implemented; anything else should fail loudly rather than pretend to work.
"""

from __future__ import annotations

import time


class FakeRedis:
    def __init__(self) -> None:
        self._store: dict[str, tuple[str, float | None]] = {}

    def _expired(self, key: str) -> bool:
        item = self._store.get(key)
        if item is None:
            return True
        _, expires_at = item
        if expires_at is not None and expires_at <= time.time():
            del self._store[key]
            return True
        return False

    async def get(self, key: str) -> str | None:
        if self._expired(key):
            return None
        return self._store[key][0]

    async def set(
        self, key: str, value: str, ex: int | None = None, nx: bool = False
    ) -> bool | None:
        if nx and not self._expired(key):
            return None
        self._store[key] = (str(value), time.time() + ex if ex else None)
        return True

    async def delete(self, *keys: str) -> int:
        removed = 0
        for key in keys:
            if key in self._store:
                del self._store[key]
                removed += 1
        return removed

    async def incr(self, key: str) -> int:
        current = 0 if self._expired(key) else int(self._store[key][0])
        expires_at = None if self._expired(key) else self._store.get(key, ("0", None))[1]
        current += 1
        self._store[key] = (str(current), expires_at)
        return current

    async def expire(self, key: str, seconds: int) -> bool:
        if self._expired(key):
            return False
        value, _ = self._store[key]
        self._store[key] = (value, time.time() + seconds)
        return True

    async def ping(self) -> bool:
        return True
