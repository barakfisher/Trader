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
from app.deps import get_universe_membership
from app.main import app
from app.providers.registry import MarketDataService
from tests.conftest import TEST_INTERNAL_KEY
from tests.fakes import FakeRedis


class StubMembership:
    """The universe as a set of symbols, so no test needs Postgres."""

    def __init__(self, symbols: set[str]) -> None:
        self.symbols = symbols

    def contains(self, symbol: str) -> bool:
        return symbol in self.symbols


MEMBERS = StubMembership({"AAPL"})


@pytest.fixture
def configured_app(settings, fixture_provider):
    """The app wired to test settings, with no dependency on the ambient .env."""
    redis = FakeRedis()
    app.state.redis = redis
    app.state.market_data = MarketDataService(
        [fixture_provider], Cache(redis), RateLimiter(redis), settings
    )
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_universe_membership] = lambda: MEMBERS
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


async def test_quotes_accept_each_symbols_market(client):
    # The orchestrator sends asset class and exchange by symbol; they change only
    # how long a quote is cached, so the answer is the same as without them.
    async with client:
        response = await client.post(
            "/market/quotes",
            json={
                "symbols": ["AAPL"],
                "markets": {"AAPL": {"asset_class": "equity", "exchange": "NASDAQ"}},
            },
        )
        refused = await client.post(
            "/market/quotes",
            json={"symbols": ["AAPL"], "markets": {"AAPL": {"asset_class": "bond"}}},
        )
    assert response.status_code == 200
    assert response.json()["quotes"][0]["price_minor"] == 23214
    assert refused.status_code == 422  # an asset class the service does not know


async def test_resolve_endpoint(client):
    async with client:
        resolved = await client.get("/market/instruments/resolve", params={"query": "BTC-USD"})
        unknown = await client.get("/market/instruments/resolve", params={"query": "ZZZZZZ"})
    assert resolved.json()["resolved"]["asset_class"] == "crypto"
    assert unknown.json()["resolved"] is None


async def test_resolve_says_whether_the_universe_holds_the_symbol(client):
    async with client:
        member = await client.get("/market/instruments/resolve", params={"query": "AAPL"})
        crypto = await client.get("/market/instruments/resolve", params={"query": "BTC-USD"})
        unknown = await client.get("/market/instruments/resolve", params={"query": "ZZZZZZ"})
    assert member.json()["universe"] == {"member": True, "outside_screen": None}
    assert crypto.json()["universe"] == {"member": False, "outside_screen": "asset_class"}
    # Nothing resolved, so there is nothing whose membership could be asked.
    assert unknown.json()["universe"] is None


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
    assert response.status_code == 200
    body = response.json()
    assert body["checks"]["redis"] == "ok"
    assert body["checks"]["providers"] == "fixture"


async def test_readyz_answers_503_when_redis_is_unreachable(configured_app):
    # A readiness probe reads the status code only; "degraded" in a 200 body
    # would keep a pod that cannot serve a quote in rotation.
    class DownRedis:
        async def ping(self):
            raise ConnectionError("redis down")

    configured_app.state.redis = DownRedis()
    transport = httpx.ASGITransport(app=configured_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/readyz")
    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["checks"]["redis"].startswith("error")


async def test_request_id_is_echoed_for_cross_service_tracing(client):
    async with client:
        response = await client.post(
            "/market/quotes", json={"symbols": ["AAPL"]}, headers={"x-request-id": "abc-123"}
        )
    assert response.headers["x-request-id"] == "abc-123"


class TestPriceHistory:
    """`GET /market/history/{id}`: the stored series, the way the rules read it."""

    @pytest.fixture
    def stored(self, monkeypatch):
        from contextlib import contextmanager
        from datetime import UTC, datetime

        calls: list[dict] = []
        rows = [
            # Two observations on one day: only the later is that day's close.
            type(
                "Row",
                (),
                {
                    "as_of": datetime(2026, 9, 28, 14, 30, tzinfo=UTC),
                    "price_minor": 23095,
                    "currency": "USD",
                },
            ),
            type(
                "Row",
                (),
                {
                    "as_of": datetime(2026, 9, 28, 20, 0, tzinfo=UTC),
                    "price_minor": 22886,
                    "currency": "USD",
                },
            ),
            type(
                "Row",
                (),
                {
                    "as_of": datetime(2026, 9, 29, 20, 0, tzinfo=UTC),
                    "price_minor": 22721,
                    "currency": "USD",
                },
            ),
        ]

        class Connection:
            def execute(self, _statement, parameters):
                calls.append(parameters)
                return rows

        class Engine:
            @contextmanager
            def connect(self):
                yield Connection()

        monkeypatch.setattr("app.routers.market.get_engine", lambda: Engine())
        return calls

    async def test_one_close_per_day_oldest_first(self, client, stored):
        async with client:
            response = await client.get(
                "/market/history/f2c094ed-4c04-4c6e-8216-ddc55b8aeb6b", params={"days": 30}
            )
        assert response.status_code == 200
        body = response.json()
        assert body["days"] == 30
        assert [(c["day"], c["price_minor"]) for c in body["closes"]] == [
            ("2026-09-28", 22886),
            ("2026-09-29", 22721),
        ]
        # Bounded above by now, so a future-dated row is never drawn as today.
        assert "until" in stored[0]

    async def test_a_real_installation_excludes_fixture_rows(self, client, stored, settings):
        from app.providers.price_provenance import excluded_price_sources

        async with client:
            await client.get("/market/history/f2c094ed-4c04-4c6e-8216-ddc55b8aeb6b")
        assert stored[0]["excluded_sources"] == list(
            excluded_price_sources(settings.market_data_chain)
        )

    @pytest.mark.parametrize(
        "path",
        [
            "/market/history/not-a-uuid",
            "/market/history/f2c094ed-4c04-4c6e-8216-ddc55b8aeb6b?days=0",
        ],
    )
    async def test_a_malformed_request_is_refused(self, client, stored, path):
        async with client:
            response = await client.get(path)
        assert response.status_code == 422


def week(exchange: str, start: str, end: str) -> dict[str, str]:
    return {"exchange": exchange, "start": start, "end": end}


async def test_sessions_list_the_trading_days_with_their_closes(client):
    # Thanksgiving week 2026: Thursday closed, Friday closes at 13:00 New York.
    async with client:
        response = await client.get(
            "/market/sessions", params=week("NMS", "2026-11-23", "2026-11-29")
        )
    assert response.status_code == 200
    body = response.json()
    assert body["calendar"] == "XNYS"
    days = [(s["day"], s["closes_at"], s["early_close"]) for s in body["sessions"]]
    assert days == [
        ("2026-11-23", "2026-11-23T21:00:00Z", False),
        ("2026-11-24", "2026-11-24T21:00:00Z", False),
        ("2026-11-25", "2026-11-25T21:00:00Z", False),
        ("2026-11-27", "2026-11-27T18:00:00Z", True),
    ]


async def test_sessions_refuse_what_the_calendar_cannot_answer(client):
    async with client:
        unknown = await client.get(
            "/market/sessions", params=week("XETRA", "2026-11-23", "2026-11-29")
        )
        reversed_span = await client.get(
            "/market/sessions", params=week("NMS", "2026-11-29", "2026-11-23")
        )
        uncovered = await client.get(
            "/market/sessions", params=week("NMS", "2026-11-23", "2031-06-01")
        )
    assert unknown.status_code == 422
    assert reversed_span.status_code == 422
    assert uncovered.status_code == 503
