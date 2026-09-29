"""Recurring phrases in headlines: auto-discovery's source of candidate themes (FR-11).

What is pinned: a theme recurs across *distinct stories from several outlets*,
never within one headline, one publisher, or one story republished under
slightly different headlines; the names of what the headlines were fetched for
are cut out before phrases are built; phrases found in exactly the same stories,
and wordings nested in each other found in mostly the same stories, are one
candidate; and the order is total, so a rerun over the same headlines
proposes the same things. The syndication case is taken from the first real
GDELT headlines (2026-09-27). The endpoint test pins
the wire and that the followed instruments' names reach the extractor.
"""

from __future__ import annotations

import random
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.db import get_engine
from app.main import app
from app.topics import discovery
from app.topics.discovery import (
    EVIDENCE_HEADLINES,
    MIN_SOURCES,
    MIN_STORIES,
    VARIANT_SHARE,
    Headline,
    Phrase,
    _representative,
    fold,
    group_stories,
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


def _each_story(phrases: list[str], start: int) -> list[tuple[str, str]]:
    """One story per phrase, each with its own framing and outlet."""
    return [
        (f"{_CONTEXTS[start + i]} {phrase} {_PLACES[start + i]}", f"o{start + i}")
        for i, phrase in enumerate(phrases)
    ]


#: One launch, worded the ways 2026-09-29's headlines worded it: most carry the
#: product's full name, some a part of it. Counted phrase by phrase, it spent
#: seven of that run's eight resolve slots.
_LAUNCH = ["open agent safety platform"] * 3 + ["open agent safety", "agent safety platform"]


def test_wordings_of_one_launch_are_one_candidate() -> None:
    # "open agent safety" and "agent safety platform" are not inside each other;
    # they join through the "agent safety" inside both, found in their stories.
    phrases = recurring_phrases(_headlines(*_each_story(_LAUNCH, 0)))
    # The wording in most stories speaks for the group, over longer ones in fewer.
    assert [(p.text, p.story_count) for p in phrases] == [("agent safety", 5)]


def test_a_longer_phrase_in_few_of_a_wider_themes_stories_stays_its_own() -> None:
    # "ai agents" is in eight stories and "rogue ai agents" in three of them: the
    # narrower phrase is a theme of its own, and the wider one is not absorbed.
    rows = _each_story(["ai agents"] * 5 + ["rogue ai agents"] * 3, 0)
    assert _texts(rows) == ["ai agents", "rogue ai agents"]


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


@pytest.mark.parametrize("word", ["nasdaq", "us", "release", "releases", "face", "ceo", "keep"])
def test_the_words_that_followed_one_companys_news_are_generic(word: str) -> None:
    assert _texts(_stories(word, 4)) == []


@pytest.mark.parametrize("word", ["launch", "launches", "unveil", "unveils"])
def test_newsroom_verbs_from_the_first_market_feed_run_are_generic(word: str) -> None:
    assert _texts(_stories(f"{word} robots", 4)) == ["robots"]


def _from(rows: list[tuple[str, str]], *countries: str | None) -> list[Headline]:
    return [
        Headline(f"a{i}", title, source, None, (), country)
        for i, ((title, source), country) in enumerate(zip(rows, countries, strict=True))
    ]


def test_a_phrase_reports_the_country_whose_press_carried_most_of_it() -> None:
    (top,) = recurring_phrases(_from(_stories("cash rate", 4), "AS", "AS", "AS", "US"))
    assert top.lead_country == ("AS", 3)


def test_outlets_of_no_known_country_count_against_the_lead() -> None:
    (top,) = recurring_phrases(_from(_stories("brent crude", 4), "IN", None, None, "US"))
    assert top.article_count == 4
    assert top.lead_country == ("IN", 1)


def test_a_tie_for_the_lead_country_goes_to_the_first_code() -> None:
    (top,) = recurring_phrases(_from(_stories("gold silver", 4), "UK", "IN", "UK", "IN"))
    assert top.lead_country == ("IN", 2)


def test_a_phrase_from_unlisted_outlets_has_no_lead_country() -> None:
    (top,) = recurring_phrases(_headlines(*_stories("rate cuts", 3)))
    assert top.lead_country == (None, 0)


def test_wall_street_is_generic_market_vocabulary() -> None:
    """Sixth in each of the market feed's three measured samples, naming no theme."""
    assert _texts(_stories("Wall Street", 4)) == []


def _linked(rows: list[tuple[str, str]], *symbols: tuple[str, ...]) -> list[Headline]:
    return [
        Headline(f"a{i}", title, source, None, links)
        for i, ((title, source), links) in enumerate(zip(rows, symbols, strict=True))
    ]


def test_a_phrase_reports_the_instrument_most_of_its_articles_are_about() -> None:
    headlines = _linked(
        _stories("agent safety", 4), ("NVDA",), ("NVDA", "MSFT"), ("NVDA",), ("AAPL",)
    )
    [phrase] = recurring_phrases(headlines)
    assert phrase.lead_instrument == ("NVDA", 3)
    assert phrase.article_count == 4


def test_articles_linked_to_nothing_count_against_the_lead() -> None:
    # A broader feed's market news links to no followed instrument; it still
    # counts in the denominator, so such a theme reads as spread.
    headlines = _linked(_stories("rate cuts", 4), ("NVDA",), (), (), ())
    [phrase] = recurring_phrases(headlines)
    assert phrase.lead_instrument == ("NVDA", 1)


def test_a_tie_for_the_lead_goes_to_the_first_symbol() -> None:
    headlines = _linked(_stories("chip export", 4), ("NVDA",), ("AMD",), ("NVDA",), ("AMD",))
    [phrase] = recurring_phrases(headlines)
    assert phrase.lead_instrument == ("AMD", 2)


def test_a_phrase_in_unlinked_headlines_has_no_lead() -> None:
    [phrase] = recurring_phrases(_headlines(*_stories("rate cuts", 3)))
    assert phrase.lead_instrument == (None, 0)


def test_evidence_is_bounded() -> None:
    (top, *_) = recurring_phrases(_headlines(*_stories("rare earths", EVIDENCE_HEADLINES + 3)))
    assert top.story_count == EVIDENCE_HEADLINES + 3
    assert len(top.headlines) == EVIDENCE_HEADLINES


@pytest.mark.parametrize(
    ("word", "folded"), [("centres", "centre"), ("gas", "gas"), ("glass", "glass")]
)
def test_plural_folding(word: str, folded: str) -> None:
    assert fold(word) == folded


# --- the indexes: the same answers as comparing everything -------------------
#
# A week of the market feed is ~28,000 headlines and ~7,000 recurring phrases,
# and comparing every pair took 69 s against the orchestrator's 30 s
# timeout. Both comparisons now go through an index. The references below are
# the pairwise versions they replaced, kept only to prove the answers did not move.


def _every_story(headlines: list[Headline], names: set[tuple[str, ...]] | None = None) -> list[int]:
    firsts: list[frozenset[str]] = []
    numbers: list[int] = []
    for headline in headlines:
        words = story_words(headline.title, names)
        number = next((i for i, first in enumerate(firsts) if same_story(words, first)), None)
        if number is None:
            number = len(firsts)
            firsts.append(words)
        numbers.append(number)
    return numbers


def _every_pair(phrases: list[Phrase]) -> list[Phrase]:
    def inside(longer: tuple[str, ...], shorter: tuple[str, ...]) -> bool:
        size = len(shorter)
        return len(longer) > size and any(
            longer[i : i + size] == shorter for i in range(len(longer) - size + 1)
        )

    parent = list(range(len(phrases)))

    def root(i: int) -> int:
        while parent[i] != i:
            i = parent[i]
        return i

    by_stories: dict[frozenset[int], int] = {}
    for i, phrase in enumerate(phrases):
        parent[root(i)] = root(by_stories.setdefault(frozenset(phrase.stories), i))
    for i, shorter in enumerate(phrases):
        for j, longer in enumerate(phrases):
            if inside(longer.key, shorter.key) and len(longer.stories) >= VARIANT_SHARE * len(
                shorter.stories
            ):
                parent[root(i)] = root(j)
    groups: dict[int, Phrase] = {}
    for i, phrase in enumerate(phrases):
        current = groups.get(root(i))
        if current is None or _representative(phrase) < _representative(current):
            groups[root(i)] = phrase
    return list(groups.values())


def _varied_headlines(seed: int) -> list[Headline]:
    """Headlines built to exercise every branch: common words shared by most of them,
    republications with words appended, exact copies, short headlines, nested wordings."""
    rng = random.Random(seed)
    common = ["ai", "rate", "oil", "data", "center", "bond", "yield"]
    rare = [f"w{i}" for i in range(120)]
    rows: list[tuple[str, str]] = []
    for n in range(700):
        size = rng.choice([1, 2, 3, 3, 4, 5, 6, 8])
        words = rng.sample(common, rng.randint(0, 3)) + rng.sample(rare, size)
        rng.shuffle(words)
        title = " ".join(words)
        rows.append((title, f"outlet-{rng.randint(0, 9)}"))
        if rng.random() < 0.3:
            rows.append((f"{title} {rng.choice(rare)}", f"outlet-{rng.randint(0, 9)}"))
        if rng.random() < 0.1:
            rows.append((title, f"outlet-{rng.randint(0, 9)}"))
        if n % 50 == 0:
            rows.append(("Nvidia data center ai agents w1 w2", "outlet-1"))
    # Nested wordings on each side of VARIANT_SHARE: a three-word phrase in 4 of
    # its two-word core's 5 stories joins it (0.8), in 3 of 5 does not (0.6).
    # The core's words also appear apart, so no single word joins the two for it.
    for theme, inside in enumerate([4, 3, 4, 3]):
        core = f"t{theme}a t{theme}b"
        for story in range(5):
            context = " ".join(rng.sample(rare, 4))
            wording = f"{core} t{theme}c" if story < inside else core
            rows.append((f"{context} {wording}", f"outlet-{story}"))
        for story in range(3):
            first, second = rng.sample(rare, 2)
            rows.append((f"t{theme}a {first} t{theme}b {second}", f"outlet-{story}"))
    return _headlines(*rows)


def _described(phrases: list[Phrase]) -> list[tuple[object, ...]]:
    return [(p.key, p.text, sorted(p.stories), sorted(p.sources), p.article_ids) for p in phrases]


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_the_story_index_groups_exactly_as_comparing_every_story(seed: int) -> None:
    headlines = _varied_headlines(seed)
    names = {("nvidia",)}
    assert group_stories(headlines, names) == _every_story(headlines, names)
    assert len(set(group_stories(headlines, names))) < len(headlines)  # some did group


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_the_phrase_index_finds_exactly_the_candidates_comparing_every_pair_did(
    seed: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    headlines = _varied_headlines(seed)
    indexed = recurring_phrases(headlines, exclude_names=["Nvidia"], min_sources=1)
    monkeypatch.setattr(discovery, "group_stories", _every_story)
    monkeypatch.setattr(discovery, "_one_per_theme", _every_pair)
    compared = recurring_phrases(headlines, exclude_names=["Nvidia"], min_sources=1)
    assert _described(indexed) == _described(compared)
    assert len(indexed) > 20


def test_a_word_every_headline_shares_costs_no_comparison(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The case that made the index necessary: "ai" or "rate" in thousands of headlines.

    A common word alone can never make two headlines one story, so it must not
    make them candidates to be compared either.
    """
    calls = 0
    judge = discovery._one_story

    def counted(*args: int) -> bool:
        nonlocal calls
        calls += 1
        return judge(*args)

    monkeypatch.setattr(discovery, "_one_story", counted)
    rows = [(f"ai u{i}a u{i}b u{i}c u{i}d", f"outlet-{i}") for i in range(500)]
    assert len(set(group_stories(_headlines(*rows)))) == 500
    assert calls == 0


@pytest.mark.parametrize("size", range(1, 13))
def test_the_shared_word_floor_is_the_least_any_pairing_needs(size: int) -> None:
    fewest = min(
        shared
        for other in range(1, 40)
        for shared in range(min(size, other) + 1)
        if discovery._one_story(shared, size, other)
    )
    assert discovery._fewest_shared(size) == fewest


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
            ("NVDA",) if i < 2 else ("MSFT", "NVDA"),
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
    assert (top["lead_instrument"], top["lead_instrument_articles"]) == ("NVDA", 3)
    # Outlets "o0".."o2" are in no table: no country, and none invented.
    assert (top["lead_country"], top["lead_country_articles"]) == (None, 0)


def test_discover_names_the_country_whose_press_carried_a_phrase(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Through the committed outlet table (`data/outlets`), not a stand-in."""
    sources = ["abc.net.au", "www.abc.net.au", "cnn.com"]
    stored = [
        Headline(f"id-{i}", f"{_CONTEXTS[i]} cash rate {_PLACES[i]}", sources[i], None)
        for i in range(3)
    ]
    monkeypatch.setattr("app.routers.topics.load_window_headlines", lambda _c, *, since: stored)
    response = client.post(
        "/topics/discover",
        json={"instruments": [{"instrument_id": "i1", "symbol": "NVDA"}], "days": 7},
        headers={"x-internal-key": INTERNAL_KEY},
    )
    assert response.status_code == 200
    (top,) = [p for p in response.json()["phrases"] if p["phrase"] == "cash rate"]
    assert (top["lead_country"], top["lead_country_name"], top["lead_country_articles"]) == (
        "AS",
        "Australia",
        2,
    )


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
