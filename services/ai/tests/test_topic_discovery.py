"""Recurring phrases in headlines: auto-discovery's source of candidate themes (FR-11).

What is pinned: a theme recurs across *articles from several outlets*, never
within one headline or one publisher; the names of what the headlines were
fetched for are cut out before phrases are built; a sub-phrase found in exactly
the same articles gives way to the longer one; and the order is total, so a
rerun over the same headlines proposes the same things. The endpoint test pins
the wire and that the followed instruments' names reach the extractor.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.db import get_engine
from app.main import app
from app.topics.discovery import (
    EVIDENCE_HEADLINES,
    MIN_ARTICLES,
    MIN_SOURCES,
    Headline,
    fold,
    recurring_phrases,
)

INTERNAL_KEY = "test-key"


def _headlines(*rows: tuple[str, str]) -> list[Headline]:
    return [
        Headline(article_id=f"a{i}", title=title, source=source, published_at=None)
        for i, (title, source) in enumerate(rows)
    ]


def _outlets(title: str, count: int) -> list[tuple[str, str]]:
    """`count` articles with the same theme from `count` different outlets."""
    return [(f"{title} {i}", f"outlet-{i}") for i in range(count)]


def test_a_phrase_in_enough_articles_from_enough_outlets_recurs() -> None:
    rows = [
        (f"Grid operators brace for data centre demand story {i}", f"outlet-{i % MIN_SOURCES}")
        for i in range(MIN_ARTICLES)
    ]
    texts = [p.text for p in recurring_phrases(_headlines(*rows))]
    assert "data centre demand" in texts


def test_one_article_short_of_the_floor_is_not_a_theme() -> None:
    rows = [(f"Data centre demand story {i}", f"outlet-{i}") for i in range(MIN_ARTICLES - 1)]
    assert recurring_phrases(_headlines(*rows)) == []


def test_one_outlet_repeating_itself_is_a_house_style_not_a_theme() -> None:
    rows = [(f"Data centre demand, part {i}", "one-outlet") for i in range(MIN_ARTICLES + 2)]
    assert recurring_phrases(_headlines(*rows)) == []


def test_a_phrase_twice_in_one_headline_counts_once() -> None:
    rows = [("AI chips, AI chips everywhere", "a"), ("AI chips again", "b")]
    phrases = recurring_phrases(_headlines(*rows), min_articles=2, min_sources=2)
    by_text = {p.text: p for p in phrases}
    assert by_text["ai chips"].article_count == 2


def test_spellings_fold_together_and_the_commonest_is_shown() -> None:
    rows = [
        ("Utility signs data-centre power contract", "a"),
        ("Hyperscalers race to build data centres", "b"),
        ("Chipmaker warns on data-centre orders", "c"),
    ]
    phrases = recurring_phrases(_headlines(*rows))
    assert [(p.text, p.key) for p in phrases] == [("data centre", ("data", "centre"))]


def test_a_sub_phrase_in_exactly_the_same_articles_gives_way() -> None:
    rows = [(f"Small modular reactors approved in region {i}", f"o{i}") for i in range(3)]
    texts = {p.text for p in recurring_phrases(_headlines(*rows))}
    assert "small modular reactors" in texts
    assert "modular" not in texts
    assert "modular reactors" not in texts


def test_a_sub_phrase_with_articles_of_its_own_is_kept() -> None:
    rows = [
        *[(f"Small modular reactors approved {i}", f"o{i}") for i in range(3)],
        *[(f"Reactors restart after outage {i}", f"p{i}") for i in range(3)],
    ]
    by_text = {p.text: p for p in recurring_phrases(_headlines(*rows))}
    assert by_text["reactors"].article_count == 6


def test_generic_market_words_and_numbers_never_form_a_theme() -> None:
    rows = [(f"Shares rise to record high in 2026 after report {i}", f"o{i}") for i in range(4)]
    assert recurring_phrases(_headlines(*rows)) == []


def test_a_followed_name_is_cut_out_before_phrases_are_built() -> None:
    rows = [
        ("NuScale Power wins an order for reactor modules", "a"),
        ("NuScale Power shares slide on reactor module delay", "b"),
        ("NuScale Power names reactor module supplier", "c"),
    ]
    phrases = recurring_phrases(_headlines(*rows), exclude_names=["NuScale Power"])
    texts = {p.text for p in phrases}
    assert "reactor module" in texts
    # Neither the name nor a word inside it borrows the name's articles.
    assert not texts & {"nuscale", "nuscale power", "power"}


def test_the_rest_of_a_name_can_still_be_a_theme_elsewhere() -> None:
    rows = [(f"Power prices spike across the region {i}", f"o{i}") for i in range(3)]
    texts = {p.text for p in recurring_phrases(_headlines(*rows), exclude_names=["NuScale Power"])}
    assert "power" in texts


def test_a_shortened_name_alone_is_not_a_theme() -> None:
    rows = [(f"Constellation inks utility contract {i}", f"o{i}") for i in range(3)]
    texts = {
        p.text for p in recurring_phrases(_headlines(*rows), exclude_names=["Constellation Energy"])
    }
    assert "constellation" not in texts
    assert "utility contract" in texts


def test_order_is_total_and_strongest_first() -> None:
    rows = [
        *_outlets("Lithium glut", 4),
        *_outlets("Copper squeeze", 3),
        *_outlets("Cobalt squeeze", 3),
    ]
    texts = [p.text for p in recurring_phrases(_headlines(*rows))]
    # Most articles first; equal counts fall back to outlets, then length, then text.
    assert texts == ["squeeze", "lithium glut", "cobalt squeeze", "copper squeeze"]
    assert texts == [p.text for p in recurring_phrases(_headlines(*reversed(rows)))]


def test_evidence_is_bounded() -> None:
    rows = _outlets("Rare earths export curbs", EVIDENCE_HEADLINES + 3)
    (top, *_) = recurring_phrases(_headlines(*rows))
    assert top.article_count == EVIDENCE_HEADLINES + 3
    assert len(top.headlines) == EVIDENCE_HEADLINES


@pytest.mark.parametrize(
    ("word", "folded"), [("centres", "centre"), ("gas", "gas"), ("glass", "glass")]
)
def test_plural_folding(word: str, folded: str) -> None:
    assert fold(word) == folded


# --- the endpoint -------------------------------------------------------------


class _FakeEngine:
    @contextmanager
    def connect(self) -> Iterator[None]:
        yield None


@pytest.fixture
def client() -> Iterator[TestClient]:
    settings = Settings(_env_file=None, internal_api_key=INTERNAL_KEY)  # type: ignore[arg-type]
    app.dependency_overrides.clear()
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_engine] = _FakeEngine
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_discover_returns_phrases_with_their_headlines(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    published = datetime(2026, 9, 26, 9, 0, tzinfo=UTC)
    stored = [
        Headline(f"id-{i}", f"Nvidia and peers chase data centre power {i}", f"o{i}", published)
        for i in range(3)
    ]
    seen: dict[str, object] = {}

    def fake_load(_connection: object, *, since: datetime) -> list[Headline]:
        seen["since"] = since
        return stored

    monkeypatch.setattr("app.routers.topics.load_window_headlines", fake_load)

    response = client.post(
        "/topics/discover",
        json={
            "instruments": [
                {"instrument_id": "i1", "symbol": "NVDA", "name": "NVIDIA Corporation"}
            ],
            "days": 7,
        },
        headers={"x-internal-key": INTERNAL_KEY},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["headlines"] == 3
    assert body["min_articles"] == MIN_ARTICLES
    assert body["min_sources"] == MIN_SOURCES
    texts = [p["phrase"] for p in body["phrases"]]
    assert "data centre power" in texts
    # The followed instrument's name was cut out, so it is not a theme.
    assert not any("nvidia" in t for t in texts)
    top = next(p for p in body["phrases"] if p["phrase"] == "data centre power")
    assert top["words"] == ["data", "centre", "power"]
    assert top["headlines"][0]["article_id"] == "id-0"
    assert top["headlines"][0]["title"] == stored[0].title


def test_discover_with_no_headlines_says_so(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.routers.topics.load_window_headlines", lambda _c, *, since: [])
    response = client.post("/topics/discover", json={}, headers={"x-internal-key": INTERNAL_KEY})
    assert response.status_code == 200
    assert response.json()["headlines"] == 0
    assert response.json()["phrases"] == []


def test_discover_needs_the_internal_key(client: TestClient) -> None:
    assert client.post("/topics/discover", json={}).status_code == 401
