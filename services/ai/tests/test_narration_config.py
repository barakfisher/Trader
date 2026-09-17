"""The tier a UI is allowed to state, and the three cases it must not confuse.

`none` is a configuration and `free`/`paid` are billing facts. A UI that showed
"deliberately off" as "broken" would send an operator looking for a fault that
does not exist, and one that showed a paid route as free would invite a bill
nobody expected. Both directions are asserted.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import app


def _client(**overrides: object) -> TestClient:
    """A client whose settings are injected, never read from a developer's .env.

    A test whose result depends on a file outside the repository is testing the
    machine it runs on, and the green result is the misleading one.
    """
    base = {
        "_env_file": None,
        "internal_api_key": "test-key",
        "llm_provider": "openrouter",
        "llm_model": "some/model:free",
    }
    settings = Settings(**{**base, **overrides})  # type: ignore[arg-type]
    app.dependency_overrides.clear()
    from app.config import get_settings

    app.dependency_overrides[get_settings] = lambda: settings
    return TestClient(app)


def _config(client: TestClient) -> dict:
    response = client.get("/narration/config", headers={"x-internal-key": "test-key"})
    assert response.status_code == 200
    return response.json()


@pytest.mark.parametrize(
    ("model", "provider", "expected"),
    [
        ("some/model:free", "openrouter", "free"),
        ("anthropic/claude-sonnet-4", "openrouter", "paid"),
        ("some/model:free", "null", "none"),
    ],
)
def test_the_tier_a_reader_is_shown(model: str, provider: str, expected: str) -> None:
    client = _client(llm_model=model, llm_provider=provider)
    assert _config(client)["tier"] == expected


def test_a_null_provider_is_configuration_not_failure() -> None:
    """`none` must not read as an outage: nobody is billed because nobody asked."""
    body = _config(_client(llm_provider="null"))
    assert body["tier"] == "none"
    assert body["provider"] == "null"


def test_the_budget_crosses_the_wire_as_a_string() -> None:
    """Money is never a float, even when it is only ever displayed."""
    assert isinstance(_config(_client())["daily_budget_usd"], str)


def test_the_endpoint_is_not_public() -> None:
    """Same internal-key rule as every other route on this service."""
    assert _client().get("/narration/config").status_code == 401
