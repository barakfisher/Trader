"""What a UI may say about how narration is configured: on, or deliberately off.

A UI that showed "deliberately off" as "broken" would send an operator looking
for a fault that does not exist. And it may not name a model or a billing tier:
the model a call uses is chosen per user, so `LLM_MODEL` would describe calls
it does not make (the header once said "Free tier" over a paid model's prose).
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
        ("some/model:free", "openrouter", True),
        ("anthropic/claude-sonnet-4", "openrouter", True),
        ("", "openrouter", False),
        ("some/model:free", "null", False),
    ],
)
def test_narration_is_on_only_when_a_provider_and_model_are_set(
    model: str, provider: str, expected: bool
) -> None:
    client = _client(llm_model=model, llm_provider=provider)
    assert _config(client)["enabled"] is expected


def test_a_null_provider_is_configuration_not_failure() -> None:
    """Off must not read as an outage: nobody is billed because nobody asked."""
    body = _config(_client(llm_provider="null"))
    assert body["enabled"] is False
    assert body["provider"] == "null"


def test_no_model_or_tier_is_stated() -> None:
    """The environment's model is not the one a user's calls run on (D244, D353)."""
    body = _config(_client())
    assert "model" not in body
    assert "tier" not in body


def test_the_budget_crosses_the_wire_as_a_string() -> None:
    """Money is never a float, even when it is only ever displayed."""
    assert isinstance(_config(_client())["daily_budget_usd"], str)


def test_the_endpoint_is_not_public() -> None:
    """Same internal-key rule as every other route on this service."""
    assert _client().get("/narration/config").status_code == 401
