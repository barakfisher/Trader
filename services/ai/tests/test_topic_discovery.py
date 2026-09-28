"""Recurring phrases in headlines: auto-discovery's source of candidate themes (FR-11).

What is pinned: a theme recurs across *distinct stories from several outlets*,
never within one headline, one publisher, or one story republished under
slightly different headlines; the names of what the headlines were fetched for
are cut out before phrases are built; phrases found in exactly the same stories
are one candidate; and the order is total, so a rerun over the same headlines
proposes the same things. The syndication case is taken from the first real
GDELT headlines (2026-09-27). The endpoint test pins
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
    MIN_SOURCES,
    MIN_STORIES,
    Headline,
    fold,
    recurring_phrases,
    same_story,
    story_words,
)

INTERNAL_KEY = "test-key"

#: Unrelated framings, so each generated headline is its own story.
_CONTEXTS = [
    "Utilities weigh", "Banks finance", "Chipmakers court", "Regulators probe",
    "Towns oppose", "Pension managers eye", "Insurers price", "Farmers resist",
    "Landlords convert", "Cities zone", "Engineers redesign", "Lawmakers debate",
]  # fmt: skip
_PLACES = [
    "in Texas", "near Dublin", "across Ohio", "outside Oslo", "in Chile", "around Seoul",
    "in Bavaria", "near Perth", "across Quebec", "in Kenya", "around Lyon", "in Utah",
]  # fmt: skip


def _headlines(*rows: tuple[str, str]) -> list[Headline]:
    return [
        Headline(article_id=f"a{i}", title=title, source=source, published_at=None)
        for i, (title, source) in enumerate(rows)
    ]


def _stories(phrase: str, count: int, *, outlets: int | None = None) -> list[tuple[str, str]]:
    """`count` different stories mentioning `phrase`, from `outlets` outlets (default: one each)."""
    spread = outlets or count
    return [(f"{_CONTEXTS[i]} {phrase} {_PLACES[i]}", f"outlet-{i % spread}") for i in range(count)]


def _texts(rows: list[tuple[str, str]], **kwargs: object) -> list[str]:
    return [p.text for p in recurring_phrases(_headlines(*rows), **kwargs)]  # type: ignore[arg-type]


def test_a_phrase_in_enough_stories_from_enough_outlets_recurs() -> None:
    assert "data centre" in _texts(_stories("data centre", MIN_STORIES, outlets=MIN_SOURCES))


def test_one_story_short_of_the_floor_is_not_a_theme() -> None:
    assert "data centre" not in _texts(_stories("data centre", MIN_STORIES - 1))


def test_one_outlet_repeating_itself_is_a_house_style_not_a_theme() -> None:
    assert _texts(_stories("data centre", MIN_STORIES + 2, outlets=1)) == []


def test_one_story_republished_by_several_outlets_is_one_story() -> None:
    # Verbatim from 2026-09-27: one wire story, three outlets, three headlines
    # that differ only by what each site appended.
    base = "Anthropic and OpenAI sound the alarm on AI safety and seek to shape how it controlled"
    rows = [
        (base, "stardem.com"),
        (f"{base} – KTBB News , Weather , Talk", "ktbb.com"),
        (
            "Anthropic and OpenAI sound the alarm on AI safety – and seek to shape how it "
            "controlled – Winnipeg Free Press",
            "winnipegfreepress.com",
        ),
    ]
    assert _texts(rows) == []


def test_republications_group_but_different_stories_do_not() -> None:
    a = story_words("Anthropic and OpenAI sound the alarm on AI safety")
    b = story_words("Anthropic and OpenAI sound the alarm on AI safety - Winnipeg Free Press")
    c = story_words("OpenAI hires a new safety chief after Anthropic departures")
    assert same_story(a, b)
    assert not same_story(a, c)


def test_a_shared_followed_name_does_not_make_headlines_one_story() -> None:
    names = {("nuscale", "power")}
    a = story_words("NuScale Power wins an order for reactor modules", names)
    b = story_words("NuScale Power shares slide on reactor module delay", names)
    assert "nuscale" not in a
    assert not same_story(a, b)


def test_short_headlines_are_one_story_only_when_identical() -> None:
    assert not same_story(story_words("Apple earnings"), story_words("Apple earnings beat"))
    assert same_story(story_words("Uranium squeeze"), story_words("uranium squeeze"))


def test_a_phrase_twice_in_one_headline_counts_once() -> None:
    rows = [
        ("AI chips, AI chips everywhere in Texas", "a"),
        ("Banks finance AI chips in Chile", "b"),
    ]
    phrases = recurring_phrases(_headlines(*rows), min_stories=2, min_sources=2)
    by_text = {p.text: p for p in phrases}
    assert by_text["ai chips"].article_count == 2
    assert by_text["ai chips"].story_count == 2


def test_spellings_fold_together_and_the_commonest_is_shown() -> None:
    rows = [
        ("Utility signs data-centre power contract", "a"),
        ("Hyperscalers race to build data centres", "b"),
        ("Chipmaker warns on data-centre orders", "c"),
    ]
    phrases = recurring_phrases(_headlines(*rows))
    assert [(p.text, p.key) for p in phrases] == [("data centre", ("data", "centre"))]


def test_phrases_in_exactly_the_same_stories_are_one_candidate() -> None:
    texts = _texts(_stories("small modular reactors", 3))
    assert texts == ["small modular reactors"]


def test_a_sub_phrase_with_stories_of_its_own_is_kept() -> None:
    rows = [
        *_stories("small modular reactors", 3),
        *[(f"{_CONTEXTS[i]} idle reactors {_PLACES[i]}", f"p{i}") for i in range(6, 9)],
    ]
    by_text = {p.text: p for p in recurring_phrases(_headlines(*rows))}
    assert by_text["reactors"].story_count == 6
    assert "small modular reactors" in by_text


def test_generic_words_and_numbers_never_form_a_theme() -> None:
    rows = [
        ("Shares rise to record high in 2026 after report", "a"),
        ("Here is why now is the time to look again", "b"),
        ("Stocks fall: what investors need to know now", "c"),
        ("There are many things people want here", "d"),
    ]
    assert _texts(rows) == []


def test_a_followed_name_is_cut_out_before_phrases_are_built() -> None:
    rows = [
        ("NuScale Power wins an order for reactor modules", "a"),
        ("NuScale Power shares slide on reactor module delay", "b"),
        ("NuScale Power picks a reactor module supplier in Ohio", "c"),
    ]
    texts = set(_texts(rows, exclude_names=["NuScale Power"]))
    assert "reactor module" in texts
    # Neither the name nor a word inside it borrows the name's articles.
    assert not texts & {"nuscale", "nuscale power", "power"}


def test_the_rest_of_a_name_can_still_be_a_theme_elsewhere() -> None:
    texts = _texts(_stories("power grid", 3), exclude_names=["NuScale Power"])
    assert "power grid" in texts


def test_a_shortened_name_alone_is_not_a_theme() -> None:
    rows = [(f"Constellation inks utility contract {_PLACES[i]}", f"o{i}") for i in range(3)]
    texts = set(_texts(rows, exclude_names=["Constellation Energy"]))
    assert "constellation" not in texts
    assert "utility contract" in texts


def test_order_is_total_and_strongest_first() -> None:
    rows = [
        *_stories("lithium glut", 4),
        *[(f"{_CONTEXTS[i]} copper squeeze {_PLACES[i]}", f"x{i}") for i in range(4, 7)],
        *[(f"{_CONTEXTS[i]} cobalt squeeze {_PLACES[i]}", f"y{i}") for i in range(7, 10)],
    ]
    texts = _texts(rows)
    # Multi-word phrases first, however many stories the single word has; then
    # most stories, and ties fall back to outlets, articles, length, then text.
    assert texts == ["lithium glut", "cobalt squeeze", "copper squeeze", "squeeze"]
    assert texts == _texts(list(reversed(rows)))


def test_a_strong_single_word_still_follows_the_multi_word_phrases() -> None:
    rows = [
        *_stories("tariffs", 8),
        *[(f"{_CONTEXTS[i]} grid batteries {_PLACES[i]}", f"g{i}") for i in range(8, 11)],
    ]
    assert _texts(rows) == ["grid batteries", "tariffs"]


@pytest.mark.parametrize("word", ["buy", "pro", "use", "billion", "season", "prediction"])
def test_the_words_that_spent_the_first_real_budget_are_generic(word: str) -> None:
    assert _texts(_stories(word, 4)) == []


def test_evidence_is_bounded() -> None:
    (top, *_) = recurring_phrases(_headlines(*_stories("rare earths", EVIDENCE_HEADLINES + 3)))
    assert top.story_count == EVIDENCE_HEADLINES + 3
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
        Headline(
            f"id-{i}",
            f"Nvidia and {_CONTEXTS[i]} data centre power {_PLACES[i]}",
            f"o{i}",
            published,
        )
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
    assert body["min_stories"] == MIN_STORIES
    assert body["min_sources"] == MIN_SOURCES
    texts = [p["phrase"] for p in body["phrases"]]
    assert "data centre power" in texts
    # The followed instrument's name was cut out, so it is not a theme.
    assert not any("nvidia" in t for t in texts)
    top = next(p for p in body["phrases"] if p["phrase"] == "data centre power")
    assert top["words"] == ["data", "centre", "power"]
    assert top["story_count"] == 3
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
