"""`POST /news/collect`: the request reaches the collection run, and its stats come back.

The run itself is `test_news_collection.py`'s; what is pinned here is the wire -
that `lookback_hours` becomes the run's `lookback`, and that the market feed's
stats come back.
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


def test_the_lookback_reaches_the_run_and_the_market_stats_come_back(seen: dict) -> None:
    result = _post({**BODY, "lookback_hours": 12})
    assert seen["lookback"] == timedelta(hours=12)
    assert (result["market_articles"], result["pruned"]) == (3, 2)
    assert result["suspected_networks"] == [
        {"source": "new.example", "headlines": 25, "templated": 24}
    ]
