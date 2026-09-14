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
from tests.fakes import FakeRedis


@pytest.fixture
def client(settings, fixture_provider) -> httpx.AsyncClient:
    redis = FakeRedis()
    app.state.redis = redis
    app.state.market_data = MarketDataService(
        [fixture_provider], Cache(redis), RateLimiter(redis), settings
    )
    transport = httpx.ASGITransport(app=app)
    # The market router is internal-only; a client without the shared key gets 401.
    return httpx.AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-internal-key": get_settings().internal_api_key},
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


async def test_market_routes_require_the_internal_key(settings, fixture_provider):
    redis = FakeRedis()
    app.state.redis = redis
    app.state.market_data = MarketDataService(
        [fixture_provider], Cache(redis), RateLimiter(redis), settings
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as anonymous:
        response = await anonymous.post("/market/quotes", json={"symbols": ["AAPL"]})
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
