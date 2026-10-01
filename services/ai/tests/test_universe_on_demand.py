"""On-demand profiles: Yahoo's payload mapped by the loader's own rule, every way
a fetch can end named, and a request answered before any fetch runs.

The SQL - never overwriting a screened profile, and no topic reader seeing an
on-demand one - is `tests/integration/test_on_demand_sql.py`'s.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.db import get_engine
from app.deps import get_embedder, get_profile_source
from app.main import app
from app.routers import universe as universe_router
from app.universe import on_demand
from app.universe.profile_source import (
    ProfileSourceError,
    YahooProfileSource,
    build_profile_source,
    instrument_from_info,
)
from app.universe.snapshot import PRIMARY_US_EXCHANGES, UniverseInstrument

INTERNAL_KEY = "test-key"
US_VENUE = PRIMARY_US_EXCHANGES[0]

#: The fields Yahoo returned for BYND on 2026-10-01, description shortened.
BYND_INFO: dict[str, Any] = {
    "quoteType": "EQUITY",
    "exchange": "NMS",
    "currency": "USD",
    "marketCap": 142022144,
    "longName": "Beyond Meat, Inc.",
    "sector": "Consumer Defensive",
    "industry": "Packaged Foods",
    "longBusinessSummary": "Beyond Meat, Inc., a plant-based meat company, ...",
}


def _bynd() -> UniverseInstrument:
    member = instrument_from_info("BYND", BYND_INFO)
    assert member is not None
    return member


BYND = _bynd()


def _settings(chain: str) -> Settings:
    return Settings(_env_file=None, market_data_providers=chain)  # type: ignore[arg-type]


class TestFromYahoo:
    def test_maps_a_small_equity_by_the_loaders_rule(self) -> None:
        expected = UniverseInstrument(
            symbol="BYND",
            name="Beyond Meat, Inc.",
            asset_class="equity",
            exchange="NMS",
            currency="USD",
            market_cap_minor=14202214400,
            net_assets_minor=None,
            sector="Consumer Defensive",
            industry="Packaged Foods",
            category=None,
            description="Beyond Meat, Inc., a plant-based meat company, ...",
        )
        assert expected == BYND

    def test_an_etf_carries_net_assets_and_category(self) -> None:
        info = {**BYND_INFO, "quoteType": "ETF", "netAssets": 5e8, "category": "Large Blend"}
        etf = instrument_from_info("TINYETF", info)
        assert etf is not None
        assert (etf.asset_class, etf.net_assets_minor, etf.market_cap_minor, etf.category) == (
            "etf",
            50_000_000_000,
            None,
            "Large Blend",
        )

    @pytest.mark.parametrize(
        "info",
        [
            {},  # Yahoo's answer for a symbol it does not know
            {**BYND_INFO, "quoteType": "CRYPTOCURRENCY"},
            {**BYND_INFO, "exchange": None},
        ],
    )
    def test_anything_unscreenable_is_none(self, info: dict[str, Any]) -> None:
        assert instrument_from_info("X", info) is None

    def test_a_missing_description_is_kept_missing(self) -> None:
        info = {**BYND_INFO, "longBusinessSummary": "  "}
        member = instrument_from_info("BYND", info)
        assert member is not None and member.description is None


class TestSourceChoice:
    def test_yahoo_when_the_chain_prices_through_it(self) -> None:
        assert isinstance(build_profile_source(_settings("yfinance,fixture")), YahooProfileSource)

    def test_none_on_a_fixture_only_chain(self) -> None:
        assert build_profile_source(_settings("fixture")) is None


class FakeSource:
    source = "test"
    license = "test"

    def __init__(self, answer: UniverseInstrument | None | Exception) -> None:
        self.answer = answer
        self.asked: list[str] = []

    async def profile(self, symbol: str) -> UniverseInstrument | None:
        self.asked.append(symbol)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


class FakeEngine:
    @contextmanager
    def connect(self) -> Iterator[None]:
        yield None

    @contextmanager
    def begin(self) -> Iterator[None]:
        yield None


class FakeEmbedder:
    model = "test-model"


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """The three SQL steps, replaced: what exists, what was inserted, what was embedded."""
    state: dict[str, Any] = {
        "exists": False,
        "inserted": [],
        "embedded": [],
        "insert_returns": "i-1",
    }

    def insert(connection, member, **kwargs):  # noqa: ANN001, ANN202
        state["inserted"].append(member)
        return state["insert_returns"]

    async def embed(connection, instrument_id, embedder):  # noqa: ANN001, ANN202
        if state.get("embed_fails"):
            raise RuntimeError("embedding provider down")
        state["embedded"].append(instrument_id)
        return True

    monkeypatch.setattr(on_demand, "profile_exists", lambda connection, symbol: state["exists"])
    monkeypatch.setattr(on_demand, "insert_on_demand", insert)
    monkeypatch.setattr(on_demand, "embed_profile", embed)
    return state


async def _run(source: FakeSource) -> str:
    return await on_demand.profile_on_demand(
        "BYND",
        source=source,
        engine=FakeEngine(),  # type: ignore[arg-type]
        embedder=FakeEmbedder(),  # type: ignore[arg-type]
    )


class TestOutcomes:
    async def test_profiles_and_embeds_a_real_gap(self, store: dict[str, Any]) -> None:
        assert await _run(FakeSource(BYND)) == "profiled"
        assert store["inserted"] == [BYND]
        assert store["embedded"] == ["i-1"]

    async def test_asks_nothing_when_a_profile_exists(self, store: dict[str, Any]) -> None:
        store["exists"] = True
        source = FakeSource(BYND)
        assert await _run(source) == "already_profiled"
        assert source.asked == []

    async def test_a_lost_insert_race_is_already_profiled(self, store: dict[str, Any]) -> None:
        store["insert_returns"] = None
        assert await _run(FakeSource(BYND)) == "already_profiled"
        assert store["embedded"] == []

    @pytest.mark.parametrize(
        ("answer", "outcome"),
        [
            (None, "no_listing"),
            (ProfileSourceError("HTTP 429"), "source_error"),
            (replace(BYND, exchange="GER"), "outside_screen"),
            (replace(BYND, description=None), "no_description"),
            (replace(BYND, currency=None), "no_currency"),
        ],
    )
    async def test_every_other_ending_writes_nothing(
        self, store: dict[str, Any], answer: Any, outcome: str
    ) -> None:
        assert await _run(FakeSource(answer)) == outcome
        assert store["inserted"] == []

    async def test_a_failed_embedding_keeps_the_profile(self, store: dict[str, Any]) -> None:
        store["embed_fails"] = True
        assert await _run(FakeSource(BYND)) == "profiled"
        assert store["inserted"] == [BYND]


class TestRequest:
    @pytest.fixture
    def client(self, monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
        state: dict[str, Any] = {"source": FakeSource(BYND), "exists": False, "fetched": []}

        async def fetch(symbol, source, engine, embedder):  # noqa: ANN001, ANN202
            state["fetched"].append(symbol)
            universe_router._in_flight.discard(symbol)

        monkeypatch.setattr(universe_router, "_fetch", fetch)
        monkeypatch.setattr(
            universe_router, "profile_exists", lambda connection, symbol: state["exists"]
        )
        settings = Settings(_env_file=None, internal_api_key=INTERNAL_KEY)  # type: ignore[arg-type]
        app.dependency_overrides[get_settings] = lambda: settings
        app.dependency_overrides[get_engine] = FakeEngine
        app.dependency_overrides[get_embedder] = FakeEmbedder
        app.dependency_overrides[get_profile_source] = lambda: state["source"]
        yield state
        app.dependency_overrides.clear()
        universe_router._in_flight.clear()

    def _post(self, symbol: str = "bynd") -> Any:
        return TestClient(app).post(
            "/universe/profiles", json={"symbol": symbol}, headers={"x-internal-key": INTERNAL_KEY}
        )

    def test_answers_202_and_fetches_after(self, client: dict[str, Any]) -> None:
        response = self._post()
        assert response.status_code == 202
        assert response.json() == {"symbol": "BYND", "status": "queued"}
        assert client["fetched"] == ["BYND"]

    def test_an_existing_profile_is_not_fetched_again(self, client: dict[str, Any]) -> None:
        client["exists"] = True
        assert self._post().json()["status"] == "already_profiled"
        assert client["fetched"] == []

    def test_one_fetch_per_symbol_at_a_time(self, client: dict[str, Any]) -> None:
        universe_router._in_flight.add("BYND")
        assert self._post().json()["status"] == "in_progress"
        assert client["fetched"] == []

    def test_no_source_is_a_configuration(self, client: dict[str, Any]) -> None:
        client["source"] = None
        assert self._post().json()["status"] == "unavailable"
        assert client["fetched"] == []

    def test_refuses_what_is_not_a_symbol(self, client: dict[str, Any]) -> None:
        assert self._post("BYND; DROP").status_code == 422
