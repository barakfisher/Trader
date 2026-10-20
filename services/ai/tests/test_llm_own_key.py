"""A user's own OpenRouter key (D206-D210): encrypted at rest, checked on save,
used for their calls outside the cap and the daily guard, marked failed when refused.

The store is a fake here; `tests/integration/test_own_key_sql.py` uses the real table.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings, get_settings
from app.llm.base import (
    Caller,
    LLMCompletion,
    LLMRequestError,
    MonthlyCapReachedError,
    OwnKeyFailedError,
    TokenUsage,
)
from app.llm.call_log import CallEntry
from app.llm.factory import build_llm
from app.llm.key_vault import KeyVault, KeyVaultError, build_vault
from app.llm.monthly_cap import CapMonth
from app.llm.own_key import (
    KEY_FAILURES,
    LAST_CHARACTERS,
    KeyCheck,
    OpenRouterKeyChecker,
    OwnKeyProvider,
    SavedKey,
    UsableKey,
)
from app.main import app
from app.routers.own_keys import get_key_checker, get_own_keys
from tests.fakes import FakeRedis

USER = "00000000-0000-0000-0000-0000000000c1"
OWN_KEY = "sk-or-v1-" + "a" * 56 + "c0de"
INSTALLATION_KEY = "sk-or-v1-installation"
MODEL = "vendor/model"
INTERNAL_KEY = "own-key-test-internal-key"
NOW = datetime(2026, 10, 20, 12, tzinfo=UTC)


# -- the vault ------------------------------------------------------------------


def test_a_key_is_stored_encrypted_and_read_back() -> None:
    vault = KeyVault([Fernet.generate_key().decode()])
    token = vault.encrypt(OWN_KEY)
    assert OWN_KEY not in token
    assert vault.decrypt(token) == OWN_KEY


def test_rotation_the_first_key_encrypts_and_every_key_decrypts() -> None:
    old, new = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    token = KeyVault([old]).encrypt(OWN_KEY)
    both = KeyVault([new, old])
    assert both.decrypt(token) == OWN_KEY
    rotated = both.rotate(token)
    assert KeyVault([new]).decrypt(rotated) == OWN_KEY
    with pytest.raises(KeyVaultError):
        KeyVault([new]).decrypt(token)


def test_an_empty_setting_turns_own_keys_off_and_a_malformed_one_refuses_to_start() -> None:
    assert build_vault(" , ") is None
    assert Settings(_env_file=None, app_env="test").llm_key_encryption_keys == ""
    with pytest.raises(ValidationError, match="LLM_KEY_ENCRYPTION_KEYS"):
        Settings(_env_file=None, app_env="test", llm_key_encryption_keys="not-a-fernet-key")
    key = Fernet.generate_key().decode()
    assert Settings(_env_file=None, app_env="test", llm_key_encryption_keys=f"{key}, {key}")


# -- the wrapper ----------------------------------------------------------------


class _Store:
    def __init__(self, key: str | None = OWN_KEY, error: Exception | None = None) -> None:
        self._key = key
        self._error = error
        self.failed: list[tuple[str, str, str]] = []
        self.asked: list[str] = []

    def usable_key(self, user_id: str) -> UsableKey | None:
        self.asked.append(user_id)
        if self._error is not None:
            raise self._error
        return None if self._key is None else UsableKey(self._key, "token")

    def mark_failed(self, user_id: str, token: str, failure: str) -> None:
        self.failed.append((user_id, token, failure))


class _Provider:
    name = "stub"
    charges_per_token = True

    def __init__(self, error: Exception | None = None) -> None:
        self.calls = 0
        self._error = error

    async def complete(self, **_: Any) -> LLMCompletion:
        self.calls += 1
        if self._error is not None:
            raise self._error
        return LLMCompletion("ok", MODEL, TokenUsage(1, 1), 7, self.name)

    async def converse(self, **_: Any) -> LLMCompletion:
        return await self.complete()

    async def record_verdict(self, call_id: int | None, verdict: str) -> None:
        return None


def _routed(
    store: _Store, own: _Provider | None = None
) -> tuple[OwnKeyProvider, _Provider, _Provider, list[str]]:
    inner, own = _Provider(), own or _Provider()
    keys: list[str] = []

    def adapter(api_key: str) -> _Provider:
        keys.append(api_key)
        return own

    return OwnKeyProvider(inner, store, adapter), inner, own, keys


async def test_a_user_with_a_valid_key_is_served_with_it() -> None:
    provider, inner, own, keys = _routed(_Store())
    completion = await provider.complete(system=None, user="q", caller=Caller("ask", USER))
    assert (inner.calls, own.calls, keys) == (0, 1, [OWN_KEY])
    assert completion.paid_by == "own_key"


async def test_a_user_without_one_and_a_call_for_nobody_take_the_installations_path() -> None:
    store = _Store(key=None)
    provider, inner, own, _ = _routed(store)
    mine = await provider.complete(system=None, user="q", caller=Caller("ask", USER))
    nobody = await provider.complete(system=None, user="q", caller=Caller("narration"))
    assert (inner.calls, own.calls, store.asked) == (2, 0, [USER])
    assert mine.paid_by == nobody.paid_by == "installation"


async def test_a_store_that_cannot_be_read_falls_back_to_the_installations_path() -> None:
    provider, inner, own, _ = _routed(_Store(error=RuntimeError("database down")))
    await provider.complete(system=None, user="q", caller=Caller("ask", USER))
    assert (inner.calls, own.calls) == (1, 0)


@pytest.mark.parametrize(("status", "failure"), sorted(KEY_FAILURES.items()))
async def test_a_key_openrouter_refuses_is_marked_failed_and_the_call_fails(
    status: int, failure: str
) -> None:
    store = _Store()
    refused = _Provider(LLMRequestError("openrouter", f"HTTP {status}", status_code=status))
    provider, inner, _, _ = _routed(store, refused)
    with pytest.raises(OwnKeyFailedError) as error:
        await provider.complete(system=None, user="q", caller=Caller("ask", USER))
    assert error.value.paid_by == "own_key"
    assert store.failed == [(USER, "token", failure)]
    # Not retried on the installation's key: the user is told (D207).
    assert inner.calls == 0


async def test_any_other_failure_is_the_calls_and_leaves_the_key_alone() -> None:
    store = _Store()
    provider, inner, _, _ = _routed(
        store, _Provider(LLMRequestError("openrouter", "HTTP 503", status_code=503))
    )
    with pytest.raises(LLMRequestError) as error:
        await provider.complete(system=None, user="q", caller=Caller("ask", USER))
    assert not isinstance(error.value, OwnKeyFailedError)
    assert error.value.paid_by == "own_key"
    assert (store.failed, inner.calls) == ([], 0)


# -- assembled: outside the cap and the daily guard, inside the recorder ----------


class _Log:
    def __init__(self) -> None:
        self.entries: list[CallEntry] = []

    def record(self, entry: CallEntry) -> int:
        self.entries.append(entry)
        return len(self.entries)

    def set_verdict(self, call_id: int, verdict: str) -> None:
        return None


class _SpentLedger:
    def month(self, user_id: str, now: datetime) -> CapMonth:
        return CapMonth(0, 0, NOW)


def _assembled(store: _Store, answer: httpx.Response) -> tuple[Any, _Log, list[str]]:
    sent: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request.headers["authorization"])
        return answer

    log = _Log()
    provider = build_llm(
        Settings(
            _env_file=None,
            app_env="test",
            llm_provider="openrouter",
            openrouter_api_key=INSTALLATION_KEY,
            llm_model=MODEL,
            # Spent before the first call: only a call outside the guard can be made.
            llm_daily_budget_usd=Decimal("0"),
        ),
        FakeRedis(),
        transport=httpx.MockTransport(handler),
        call_log=log,
        cap_ledger=_SpentLedger(),
        own_keys=store,
    )
    return provider, log, sent


def _completion_body() -> dict[str, Any]:
    return {
        "id": "c",
        "object": "chat.completion",
        "created": 0,
        "model": MODEL,
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "ok"},
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }


async def test_an_own_key_call_passes_a_spent_cap_and_daily_guard_and_is_recorded_as_such() -> None:
    provider, log, sent = _assembled(_Store(), httpx.Response(200, json=_completion_body()))
    await provider.complete(system=None, user="q", caller=Caller("ask", USER))
    assert sent == [f"Bearer {OWN_KEY}"]
    [entry] = log.entries
    assert (entry.outcome, entry.paid_by, entry.user_id) == ("ok", "own_key", USER)


async def test_a_refused_own_key_is_recorded_as_a_provider_error_on_that_key() -> None:
    store = _Store()
    provider, log, _ = _assembled(store, httpx.Response(401, json={"error": {"code": 401}}))
    with pytest.raises(OwnKeyFailedError):
        await provider.complete(system=None, user="q", caller=Caller("ask", USER))
    [entry] = log.entries
    assert (entry.outcome, entry.paid_by) == ("provider_error", "own_key")
    assert store.failed == [(USER, "token", "rejected")]


async def test_without_an_own_key_the_cap_still_refuses() -> None:
    provider, log, sent = _assembled(_Store(key=None), httpx.Response(200))
    with pytest.raises(MonthlyCapReachedError):
        await provider.complete(system=None, user="q", caller=Caller("ask", USER))
    assert sent == []
    [entry] = log.entries
    assert (entry.outcome, entry.paid_by) == ("budget_exhausted", "installation")


# -- the check on save ------------------------------------------------------------


@pytest.mark.parametrize(
    ("answer", "expected"),
    [(200, "valid"), (401, "rejected"), (403, "rejected"), (500, "unreachable")],
)
async def test_openrouter_is_asked_about_the_key(answer: int, expected: KeyCheck) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(answer, json={"data": {}})

    checker = OpenRouterKeyChecker(
        "https://or.test/api/v1/", transport=httpx.MockTransport(handler)
    )
    assert await checker.check(OWN_KEY) == expected
    [request] = seen
    assert str(request.url) == "https://or.test/api/v1/key"
    assert request.headers["authorization"] == f"Bearer {OWN_KEY}"


async def test_a_check_that_cannot_reach_openrouter_says_so() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    checker = OpenRouterKeyChecker("https://or.test", transport=httpx.MockTransport(handler))
    assert await checker.check(OWN_KEY) == "unreachable"


# -- the routes -------------------------------------------------------------------


class _RouteStore:
    def __init__(self, can_save: bool = True) -> None:
        self.can_save = can_save
        self.keys: dict[str, str] = {}

    def saved(self, user_id: str) -> SavedKey | None:
        key = self.keys.get(user_id)
        return key and SavedKey(key[-LAST_CHARACTERS:], "valid", NOW, None, None)

    def save(self, user_id: str, api_key: str) -> SavedKey:
        self.keys[user_id] = api_key
        saved = self.saved(user_id)
        assert saved is not None
        return saved

    def remove(self, user_id: str) -> bool:
        return self.keys.pop(user_id, None) is not None


class _Checker:
    def __init__(self, answer: KeyCheck) -> None:
        self.answer = answer
        self.asked: list[str] = []

    async def check(self, api_key: str) -> KeyCheck:
        self.asked.append(api_key)
        return self.answer


@pytest.fixture
def routes() -> Iterator[tuple[TestClient, _RouteStore, _Checker]]:
    store, checker = _RouteStore(), _Checker("valid")
    settings = Settings(
        _env_file=None, app_env="test", internal_api_key=INTERNAL_KEY, llm_provider="openrouter"
    )
    app.dependency_overrides.clear()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_own_keys] = lambda: store
    app.dependency_overrides[get_key_checker] = lambda: checker
    yield TestClient(app), store, checker
    app.dependency_overrides.clear()


def _put(client: TestClient, api_key: str) -> httpx.Response:
    return client.put(
        f"/llm/own-keys/{USER}",
        json={"api_key": api_key},
        headers={"x-internal-key": INTERNAL_KEY},
    )


def test_a_key_openrouter_accepts_is_saved_and_only_its_last_four_come_back(
    routes: tuple[TestClient, _RouteStore, _Checker],
) -> None:
    client, store, checker = routes
    response = _put(client, f"  {OWN_KEY} ")
    assert response.status_code == 200
    assert OWN_KEY not in response.text
    body = response.json()
    assert body["available"] is True
    assert (body["key"]["last_four"], body["key"]["status"]) == ("c0de", "valid")
    assert checker.asked == [OWN_KEY] and store.keys == {USER: OWN_KEY}

    read = client.get(f"/llm/own-keys/{USER}", headers={"x-internal-key": INTERNAL_KEY})
    assert read.json()["key"]["last_four"] == "c0de"
    removed = client.delete(f"/llm/own-keys/{USER}", headers={"x-internal-key": INTERNAL_KEY})
    assert removed.json() == {"available": True, "key": None} and store.keys == {}


@pytest.mark.parametrize(
    ("answer", "status", "code"),
    [("rejected", 422, "key_rejected"), ("unreachable", 502, "key_check_unreachable")],
)
def test_a_key_that_is_refused_or_cannot_be_checked_is_not_saved(
    routes: tuple[TestClient, _RouteStore, _Checker], answer: KeyCheck, status: int, code: str
) -> None:
    client, store, checker = routes
    checker.answer = answer
    response = _put(client, OWN_KEY)
    assert (response.status_code, response.json()["detail"]["code"]) == (status, code)
    assert OWN_KEY not in response.text and store.keys == {}


def test_what_is_not_shaped_like_a_key_is_not_sent_anywhere(
    routes: tuple[TestClient, _RouteStore, _Checker],
) -> None:
    client, store, checker = routes
    for wrong in ["short", "has a space in the middle of it", "x" * 300]:
        response = _put(client, wrong)
        assert (response.status_code, response.json()["detail"]["code"]) == (422, "key_malformed")
        assert wrong not in response.text
    assert checker.asked == [] and store.keys == {}


def test_without_encryption_keys_nothing_can_be_saved(
    routes: tuple[TestClient, _RouteStore, _Checker],
) -> None:
    client, store, checker = routes
    store.can_save = False
    response = _put(client, OWN_KEY)
    assert (response.status_code, response.json()["detail"]["code"]) == (
        503,
        "own_keys_unavailable",
    )
    assert checker.asked == []
    read = client.get(f"/llm/own-keys/{USER}", headers={"x-internal-key": INTERNAL_KEY})
    assert read.json() == {"available": False, "key": None}


def test_the_key_never_appears_in_a_log_line_of_the_request_model() -> None:
    from app.models import OwnLlmKeySave

    assert OWN_KEY not in repr(OwnLlmKeySave(api_key=OWN_KEY))
    assert OWN_KEY not in json.dumps(OwnLlmKeySave(api_key=OWN_KEY).model_dump(mode="json"))
