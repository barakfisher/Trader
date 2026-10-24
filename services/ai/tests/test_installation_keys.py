"""The Keys tab's source (D251, D288): status never values, unused keys said so, free tests only."""

from __future__ import annotations

import httpx
import pytest

from app.config import Settings
from app.installation_keys import (
    KEY_NAMES,
    LAST_ERROR_MAX_CHARS,
    TESTABLE,
    check_key,
    key_statuses,
    redact,
)

SECRET = "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef"


def _settings(**overrides) -> Settings:
    return Settings(_env_file=None, app_env="test", **overrides)


def _by_name(settings: Settings):
    return {key.name: key for key in key_statuses(settings, None)}


def test_only_provider_keys_are_listed_never_the_apps_own_secrets():
    assert "INTERNAL_API_KEY" not in KEY_NAMES
    assert "LLM_KEY_ENCRYPTION_KEYS" not in KEY_NAMES
    assert "SESSION_SECRET" not in KEY_NAMES


def test_a_status_carries_no_value():
    keys = _by_name(_settings(llm_provider="openrouter", openrouter_api_key=SECRET))
    assert keys["OPENROUTER_API_KEY"].is_set
    assert SECRET not in repr(keys)


def test_what_a_key_serves_follows_the_configuration():
    keys = _by_name(
        _settings(
            llm_provider="openrouter", embeddings_provider="openrouter", openrouter_api_key=SECRET
        )
    )
    assert keys["OPENROUTER_API_KEY"].serves == ("llm", "embeddings")
    assert keys["OPENROUTER_API_KEY"].unused is None
    assert keys["OPENAI_API_KEY"].unused == "not_chosen"


def test_a_key_no_adapter_uses_is_said_so_and_has_no_test():
    keys = _by_name(_settings(polygon_api_key="x" * 20))
    assert keys["POLYGON_API_KEY"].is_set
    assert keys["POLYGON_API_KEY"].unused == "no_adapter"
    assert not keys["POLYGON_API_KEY"].testable
    assert "POLYGON_API_KEY" not in TESTABLE


def test_an_unset_key_cannot_be_tested():
    assert not _by_name(_settings(openrouter_api_key=None))["OPENROUTER_API_KEY"].testable


def test_redaction_masks_anything_credential_shaped_and_bounds_the_length():
    assert SECRET not in redact(f"401 for key {SECRET}")
    assert "bot123456:" not in redact(
        "https://api.telegram.org/bot123456:AAEabcdefghij/sendMessage"
    )
    assert "Bearer abc" not in redact("header Bearer abc.def")
    assert len(redact("x " * LAST_ERROR_MAX_CHARS)) == LAST_ERROR_MAX_CHARS


def _transport(status: int, body: str = "{}"):
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, text=body)

    return httpx.MockTransport(handle), seen


async def test_a_test_is_one_free_get_to_the_keys_own_provider():
    transport, seen = _transport(200)
    settings = _settings(
        openrouter_api_key=SECRET, openrouter_base_url="https://openrouter.test/api/v1"
    )
    result = await check_key("OPENROUTER_API_KEY", settings, transport=transport)
    assert result is not None and result.ok and result.detail is None
    [request] = seen
    assert (request.method, str(request.url)) == ("GET", "https://openrouter.test/api/v1/key")


async def test_a_refused_key_says_why_without_echoing_the_key():
    transport, _ = _transport(401, f'{{"error": "invalid key {SECRET}"}}')
    result = await check_key(
        "OPENROUTER_API_KEY", _settings(openrouter_api_key=SECRET), transport=transport
    )
    assert result is not None and not result.ok
    assert "401" in (result.detail or "") and SECRET not in (result.detail or "")


@pytest.mark.parametrize("name", ["POLYGON_API_KEY", "NO_SUCH_KEY"])
async def test_no_test_for_a_key_without_one(name):
    assert await check_key(name, _settings(polygon_api_key="x" * 20)) is None


def test_redaction_covers_the_shapes_the_review_named():
    bare_token = "123456789:AAH" + "a" * 32
    assert "AAH" not in redact(f"token {bare_token}")
    assert "proj-" not in redact("Incorrect API key provided: sk-proj-****abcd")
    assert "s3cr3t" not in redact("GET /query?apikey=s3cr3t&symbol=AAPL")


def test_the_configured_value_is_masked_word_for_word_whatever_its_shape():
    short = "abcd1234efgh"  # no shape rule would catch a key this short
    assert short not in redact(f"provider said: bad key {short}", short)


def test_a_long_echo_is_masked_before_it_is_shortened():
    padded = "x " * 95 + SECRET
    assert not any(part in redact(padded, SECRET) for part in (SECRET[:12], SECRET[-12:]))


def test_both_routes_need_the_internal_key():
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    assert client.get("/installation/keys").status_code in (401, 403)
    assert client.post("/installation/keys/OPENROUTER_API_KEY/test").status_code in (401, 403)
