"""Configuration guards.

These exist because a misconfigured deployment is silent by nature: nothing
crashes, the service simply runs without the protection you thought it had.
"""

import pytest

from app.config import DEFAULT_INTERNAL_API_KEY, Settings


def build(**overrides) -> Settings:
    """Settings built from arguments only.

    `_env_file=None` stops pydantic-settings reading the developer's .env. Without
    it these tests pass or fail depending on whether a file exists on the machine
    running them - which is precisely the flakiness this change set removes.
    """
    return Settings(_env_file=None, **overrides)


def test_development_may_use_the_default_internal_key():
    # Both services read the same .env, so the placeholder still lets a fresh
    # clone work without any setup.
    assert build(app_env="development").internal_api_key == DEFAULT_INTERNAL_API_KEY


def test_production_refuses_to_start_with_the_default_internal_key():
    with pytest.raises(ValueError, match="INTERNAL_API_KEY"):
        build(app_env="production", internal_api_key=DEFAULT_INTERNAL_API_KEY)


def test_production_starts_with_a_real_internal_key():
    assert build(app_env="production", internal_api_key="a-real-key").is_production


def test_fixtures_directory_resolves_to_a_real_directory():
    # Guards the bug where the container path was used when running natively.
    from pathlib import Path

    assert Path(build().fixtures_dir).is_dir()
