"""`POST /news/collect`: the retention the orchestrator sends reaches the collection run.

The run itself is `test_news_collection.py`'s; what is pinned here is the wire -
that `market_retention_days` becomes the run's `market_retention`, that leaving
it out prunes nothing, and that the market feed's stats come back.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import app
from app.routers import news

INTERNAL_KEY = "test-key"
BODY = {
    "instruments": [
        {"instrument_id": "i-aapl", "symbol": "AAPL", "name": "Apple Inc.", "asset_class": "equity"}
    ]
}


class _FakeEngine:
    @contextmanager
    def begin(self) -> Iterator[None]:
        yield None


@pytest.fixture
def seen(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict]:
    calls: dict = {}

    async def fake_collect(connection, providers, scorer, instruments, **kwargs):  # noqa: ANN001
        calls.update(kwargs)
        return {
            "since": datetime(2026, 9, 29, tzinfo=UTC).isoformat(),
            "market_articles": 3,
            "pruned": 2,
            "suspected_networks": [{"source": "new.example", "headlines": 25, "templated": 24}],
        }

    monkeypatch.setattr(news, "get_engine", _FakeEngine)
    monkeypatch.setattr(news, "build_news_providers", lambda settings, cursor_for: [])
    monkeypatch.setattr(news, "collect_news", fake_collect)
    settings = Settings(_env_file=None, internal_api_key=INTERNAL_KEY)  # type: ignore[arg-type]
    app.dependency_overrides[get_settings] = lambda: settings
    yield calls
    app.dependency_overrides.clear()


def _post(body: dict) -> dict:
    response = TestClient(app).post(
        "/news/collect", json=body, headers={"x-internal-key": INTERNAL_KEY}
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_the_retention_in_days_reaches_the_run(seen: dict) -> None:
    result = _post({**BODY, "market_retention_days": 21})
    assert seen["market_retention"] == timedelta(days=21)
    assert (result["market_articles"], result["pruned"]) == (3, 2)
    assert result["suspected_networks"] == [
        {"source": "new.example", "headlines": 25, "templated": 24}
    ]


def test_no_retention_means_nothing_is_pruned(seen: dict) -> None:
    _post(BODY)
    assert seen["market_retention"] is None
