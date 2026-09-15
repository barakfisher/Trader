"""HTTP-level tests for the market router.

The app is exercised through ASGI with the fixture provider and an in-memory
Redis, so these cover the real routing, validation and serialisation without
needing any infrastructure.
"""

import httpx
import pytest

from app.config import get_settings
from app.core.cache import Cache
from app.core.ratelimit import RateLimiter
from app.main import app
from app.providers.registry import MarketDataService
from tests.conftest import TEST_INTERNAL_KEY
from tests.fakes import FakeRedis


@pytest.fixture
def configured_app(settings, fixture_provider):
    """The app wired to test settings, with no dependency on the ambient .env."""
    redis = FakeRedis()
    app.state.redis = redis
    app.state.market_data = MarketDataService(
        [fixture_provider], Cache(redis), RateLimiter(redis), settings
    )
    app.dependency_overrides[get_settings] = lambda: settings
    yield app
    app.dependency_overrides.clear()


@pytest.fixture
def client(configured_app) -> httpx.AsyncClient:
    # The market router is internal-only; a client without the shared key gets 401.
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=configured_app),
        base_url="http://test",
        headers={"x-internal-key": TEST_INTERNAL_KEY},
    )


async def test_quotes_endpoint_returns_minor_units(client):
    async with client:
        response = await client.post("/market/quotes", json={"symbols": ["AAPL", "NOPE"]})
    assert response.status_code == 200
    body = response.json()
    assert body["quotes"][0]["symbol"] == "AAPL"
    assert body["quotes"][0]["price_minor"] == 23214
    assert body["missing"] == ["NOPE"]


async def test_quotes_endpoint_rejects_an_empty_symbol_list(client):
    async with client:
        response = await client.post("/market/quotes", json={"symbols": []})
    assert response.status_code == 422


async def test_resolve_endpoint(client):
    async with client:
        resolved = await client.get("/market/instruments/resolve", params={"query": "BTC-USD"})
        unknown = await client.get("/market/instruments/resolve", params={"query": "ZZZZZZ"})
    assert resolved.json()["resolved"]["asset_class"] == "crypto"
    assert unknown.json()["resolved"] is None


async def test_fx_endpoint_reports_a_missing_pair_as_404(client):
    async with client:
        ok = await client.get("/market/fx", params={"base": "EUR", "quote": "USD"})
        missing = await client.get("/market/fx", params={"base": "XYZ", "quote": "USD"})
    assert ok.json()["rate"] == "1.1043"
    assert missing.status_code == 404


async def test_market_routes_require_the_internal_key(configured_app):
    """No key, no data - and no development bypass, whatever APP_ENV says."""
    transport = httpx.ASGITransport(app=configured_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as anonymous:
        response = await anonymous.post("/market/quotes", json={"symbols": ["AAPL"]})
    assert response.status_code == 401


async def test_market_routes_reject_a_wrong_internal_key(configured_app):
    transport = httpx.ASGITransport(app=configured_app)
    headers = {"x-internal-key": "not-the-key"}
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test", headers=headers
    ) as wrong:
        response = await wrong.post("/market/quotes", json={"symbols": ["AAPL"]})
    assert response.status_code == 401


async def test_readyz_reports_the_provider_chain(client):
    async with client:
        response = await client.get("/readyz")
    body = response.json()
    assert body["checks"]["redis"] == "ok"
    assert body["checks"]["providers"] == "fixture"


async def test_request_id_is_echoed_for_cross_service_tracing(client):
    async with client:
        response = await client.post(
            "/market/quotes", json={"symbols": ["AAPL"]}, headers={"x-request-id": "abc-123"}
        )
    assert response.headers["x-request-id"] == "abc-123"
