"""`POST /filings/upcoming-ipos`: when the daily upcoming-IPO run works, and what it answers.

What the run writes is `tests/integration/test_upcoming_listings_sql.py`'s.
Pinned here: only with the internal key; `off` is unavailable and says why;
a search that failed is a 502 the run is retried for, never "nothing new".
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.db import get_engine
from app.deps import get_filings_provider
from app.filings.base import FilingsProviderError
from app.filings.upcoming import UpcomingReport
from app.main import app
from app.routers import filings as filings_router

INTERNAL_KEY = "test-key"


@pytest.fixture
def state(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    state: dict[str, Any] = {"provider": object(), "error": None, "calls": 0}

    async def fake_track(**kwargs: Any) -> UpcomingReport:
        state["calls"] += 1
        if state["error"] is not None:
            raise state["error"]
        return UpcomingReport(
            searched=12,
            tracked=["Anthropic, PBC"],
            excluded=Counter({"blank_check": 1}),
            advanced=["Anthropic, PBC: priced"],
            listed=[],
            failed=["0000000042"],
            deferred=0,
        )

    monkeypatch.setattr(filings_router, "track_upcoming_listings", fake_track)
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None,  # type: ignore[call-arg]
        internal_api_key=INTERNAL_KEY,
    )
    app.dependency_overrides[get_engine] = lambda: object()
    app.dependency_overrides[get_filings_provider] = lambda: state["provider"]
    yield state
    app.dependency_overrides.clear()


def _post(headers: dict[str, str] | None = None) -> Any:
    return TestClient(app).post(
        "/filings/upcoming-ipos",
        headers={"x-internal-key": INTERNAL_KEY} if headers is None else headers,
    )


def test_runs_and_answers_what_it_found(state: dict[str, Any]) -> None:
    response = _post()
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "done"
    assert body["tracked"] == ["Anthropic, PBC"]
    assert body["excluded"] == {"blank_check": 1}
    assert body["failed"] == ["0000000042"]
    assert state["calls"] == 1


def test_off_is_unavailable_and_says_why(state: dict[str, Any]) -> None:
    state["provider"] = None
    body = _post().json()
    assert body["status"] == "unavailable"
    assert "FILINGS_PROVIDER" in body["reason"]
    assert state["calls"] == 0


def test_a_search_that_failed_fails_the_request(state: dict[str, Any]) -> None:
    state["error"] = FilingsProviderError("edgar", "HTTP 500")
    assert _post().status_code == 502


def test_refuses_a_caller_without_the_internal_key(state: dict[str, Any]) -> None:
    assert _post(headers={}).status_code in (401, 403)
    assert state["calls"] == 0
