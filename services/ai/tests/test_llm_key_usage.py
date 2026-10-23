"""What OpenRouter says a user's own key spent (D247-D249): read, rounded once, cached
per key state for `KEY_USAGE_TTL_SECONDS`, and never read for a refused key.

No network: OpenRouter is a mock transport, the cache a dict.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.llm.key_usage import (
    KEY_USAGE_TTL_SECONDS,
    KeyUsage,
    OpenRouterKeyUsageReader,
    cache_key,
    cached_key_usage,
    parse_key_usage,
)
from app.llm.own_key import SavedKey, UsableKey
from app.llm.payer import Payer
from app.main import app
from app.routers.own_keys import get_key_usage_reader, get_own_keys

USER = "00000000-0000-0000-0000-0000000000c1"
OWN_KEY = "sk-or-v1-" + "a" * 56 + "c0de"
INTERNAL_KEY = "key-usage-test-internal-key"
NOW = datetime(2026, 10, 23, 12, tzinfo=UTC)
#: OpenRouter's documented body, in dollars, as JSON numbers.
BODY = {
    "data": {
        "label": "sk-or-v1-a...",
        "limit": 50,
        "limit_remaining": 37.5,
        "limit_reset": "monthly",
        "usage": 80.25,
        "usage_daily": 0.4,
        "usage_weekly": 2.0000005,
        "usage_monthly": 12.5,
        "is_free_tier": False,
    }
}


def test_dollars_become_integer_micro_usd_rounded_once() -> None:
    usage = parse_key_usage(BODY, NOW)
    assert usage == KeyUsage(
        limit_micro_usd=50_000_000,
        limit_remaining_micro_usd=37_500_000,
        limit_reset="monthly",
        usage_daily_micro_usd=400_000,
        usage_weekly_micro_usd=2_000_001,  # half up, at the sixth place
        usage_monthly_micro_usd=12_500_000,
        read_at=NOW,
    )


def test_an_unlimited_key_has_no_limit_and_no_reset() -> None:
    unlimited = {
        "data": {**BODY["data"], "limit": None, "limit_remaining": None, "limit_reset": None}
    }
    usage = parse_key_usage(unlimited, NOW)
    assert usage is not None
    assert (usage.limit_micro_usd, usage.limit_remaining_micro_usd, usage.limit_reset) == (
        None,
        None,
        None,
    )


def test_a_body_not_shaped_like_openrouters_is_no_reading() -> None:
    assert parse_key_usage({"error": "x"}, NOW) is None
    assert parse_key_usage({"data": {"limit": "lots"}}, NOW) is None


@pytest.mark.parametrize(("status", "readable"), [(200, True), (401, False), (500, False)])
async def test_the_reader_asks_with_the_users_key(status: int, readable: bool) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, json=BODY)

    reader = OpenRouterKeyUsageReader(
        "https://or.test/api/v1/", transport=httpx.MockTransport(handler)
    )
    usage = await reader.read(OWN_KEY)
    assert (usage is not None) is readable
    [request] = seen
    assert str(request.url) == "https://or.test/api/v1/key"
    assert request.headers["authorization"] == f"Bearer {OWN_KEY}"


async def test_unreachable_is_no_reading() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    reader = OpenRouterKeyUsageReader("https://or.test", transport=httpx.MockTransport(handler))
    assert await reader.read(OWN_KEY) is None


class _Cache:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.ttls: dict[str, int] = {}

    async def get(self, key: str) -> str | None:
        return self.values.get(key)

    async def set(self, key: str, value: str, ex: int) -> None:
        self.values[key] = value
        self.ttls[key] = ex


class _Reader:
    def __init__(self) -> None:
        self.reads = 0

    async def read(self, api_key: str) -> KeyUsage | None:
        self.reads += 1
        return parse_key_usage(BODY, NOW)


async def test_one_read_per_key_state_until_the_cache_expires() -> None:
    cache, reader = _Cache(), _Reader()
    first = await cached_key_usage(cache, reader, user_id=USER, key_state="a", api_key=OWN_KEY)
    again = await cached_key_usage(cache, reader, user_id=USER, key_state="a", api_key=OWN_KEY)
    assert first == again and reader.reads == 1
    assert cache.ttls[cache_key(USER, "a")] == KEY_USAGE_TTL_SECONDS
    # D249: a key saved, replaced or refused since is read again at once.
    await cached_key_usage(cache, reader, user_id=USER, key_state="b", api_key=OWN_KEY)
    assert reader.reads == 2


async def test_without_a_cache_every_ask_reads() -> None:
    reader = _Reader()
    await cached_key_usage(None, reader, user_id=USER, key_state="a", api_key=OWN_KEY)
    await cached_key_usage(None, reader, user_id=USER, key_state="a", api_key=OWN_KEY)
    assert reader.reads == 2


# -- the route --------------------------------------------------------------------


class _Store:
    can_save = True

    def __init__(self, saved: SavedKey | None) -> None:
        self._saved = saved

    def saved(self, user_id: str) -> SavedKey | None:
        return self._saved

    def payer(self, user_id: str) -> Payer:
        return Payer(key=UsableKey(OWN_KEY, "token"))


@pytest.fixture
def route() -> Iterator[tuple[TestClient, _Reader, list[_Store]]]:
    reader, stores = _Reader(), [_Store(SavedKey("c0de", "valid", NOW, None, None))]
    settings = Settings(
        _env_file=None, app_env="test", internal_api_key=INTERNAL_KEY, llm_provider="openrouter"
    )
    app.dependency_overrides.clear()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_own_keys] = lambda: stores[0]
    app.dependency_overrides[get_key_usage_reader] = lambda: reader
    yield TestClient(app), reader, stores
    app.dependency_overrides.clear()


def _get(client: TestClient) -> httpx.Response:
    return client.get(f"/llm/own-keys/{USER}/usage", headers={"x-internal-key": INTERNAL_KEY})


def test_a_working_key_is_read_and_never_echoed(
    route: tuple[TestClient, _Reader, list[_Store]],
) -> None:
    client, reader, _ = route
    response = _get(client)
    assert response.status_code == 200
    assert OWN_KEY not in response.text
    body = response.json()
    assert body["key"]["last_four"] == "c0de"
    assert body["usage"]["usage_weekly_micro_usd"] == 2_000_001
    assert reader.reads == 1


@pytest.mark.parametrize(
    "saved",
    [None, SavedKey("c0de", "failed", NOW, NOW, "no_credit")],
)
def test_no_key_or_a_refused_one_is_not_read(
    route: tuple[TestClient, _Reader, list[_Store]], saved: SavedKey | None
) -> None:
    client, reader, stores = route
    stores[0] = _Store(saved)
    body = _get(client).json()
    assert body["usage"] is None
    assert reader.reads == 0
