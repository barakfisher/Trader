"""The topic eval file itself, checked without a resolver or a database.

`data/eval/topics.json` exists before the code it measures, so nothing else
reads it yet. This guards the properties that would make it quietly meaningless
rather than visibly broken.

**The one that matters most is that a user case still says what the user said.**
The cases marked `author: "user"` are the held-out set MEMORY.md asked for:
written by someone who had read neither the corpus nor the code. Their value is
entirely that nobody who writes the resolver chose them. So an expectation may
differ from the user's own line only through a correction the file names -
otherwise "the resolver cannot find SQ, so I edited the case" becomes
indistinguishable from the user having asked for something else.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
EVAL = ROOT / "data" / "eval" / "topics.json"

KNOWN_AUTHORS = {"user", "session"}
KNOWN_EXPECTATIONS = {"must_include", "resolves_to_nothing"}
#: A US ticker, an exchange-suffixed one (SAP.DE) or a crypto pair (BTC-USD).
SYMBOL_SHAPE = re.compile(r"^[A-Z]{1,5}([.-][A-Z]{1,4})?$")


def _normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower().strip())


def _symbols_as_written(line: str) -> list[str]:
    """The tickers on the right of `Topic -> A, B, C`."""
    _, _, symbols = line.partition("->")
    return [s.strip().upper() for s in symbols.split(",") if s.strip()]


@pytest.fixture(scope="module")
def data() -> dict[str, object]:
    return json.loads(EVAL.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def cases(data: dict[str, object]) -> list[dict[str, object]]:
    return data["cases"]  # type: ignore[return-value]


@pytest.fixture(scope="module")
def retired(data: dict[str, object]) -> dict[str, str]:
    return {old: entry["now"] for old, entry in data["retired_symbols"].items()}  # type: ignore[union-attr]


def test_case_ids_and_topics_are_unique(cases: list[dict[str, object]]) -> None:
    ids = [c["id"] for c in cases]
    topics = [_normalise(str(c["topic"])) for c in cases]

    assert len(ids) == len(set(ids))
    assert len(topics) == len(set(topics))


def test_every_case_names_its_author(cases: list[dict[str, object]]) -> None:
    unknown = [c["id"] for c in cases if c.get("author") not in KNOWN_AUTHORS]

    assert not unknown, f"author must be one of {sorted(KNOWN_AUTHORS)}: {unknown}"


def test_every_case_expects_exactly_one_thing(cases: list[dict[str, object]]) -> None:
    for case in cases:
        expect = case["expect"]
        assert isinstance(expect, dict)
        assert len(expect) == 1 and set(expect) <= KNOWN_EXPECTATIONS, case["id"]
        if "must_include" in expect:
            assert expect["must_include"], f"{case['id']}: an empty floor asserts nothing"
        else:
            assert expect["resolves_to_nothing"] is True, case["id"]


def test_expected_symbols_are_ticker_shaped_and_not_repeated(
    cases: list[dict[str, object]],
) -> None:
    for case in cases:
        symbols = case["expect"].get("must_include", [])  # type: ignore[union-attr]
        assert len(symbols) == len(set(symbols)), case["id"]
        malformed = [s for s in symbols if not SYMBOL_SHAPE.match(s)]
        assert not malformed, f"{case['id']}: {malformed}"


def test_no_case_expects_a_retired_symbol(
    cases: list[dict[str, object]], retired: dict[str, str]
) -> None:
    """A retired ticker can never be returned, so a case expecting one fails forever."""
    stale = [
        (c["id"], s)
        for c in cases
        for s in c["expect"].get("must_include", [])  # type: ignore[union-attr]
        if s in retired
    ]

    assert not stale, f"these tickers no longer trade under that name: {stale}"


def test_user_cases_say_what_the_user_wrote_up_to_named_corrections(
    cases: list[dict[str, object]], retired: dict[str, str]
) -> None:
    user_cases = [c for c in cases if c["author"] == "user"]
    assert user_cases, "the user-written cases are the point of this file"

    for case in user_cases:
        written = _symbols_as_written(str(case["as_written"]))
        corrected = [retired.get(s, s) for s in written]
        expected = case["expect"]["must_include"]  # type: ignore[index]

        assert expected == corrected, (
            f"{case['id']}: expects {expected}, but the user wrote {written}. "
            "Change a user case only through retired_symbols, so the edit stays visible."
        )
        if corrected != written:
            assert case.get("corrections"), f"{case['id']}: a correction must say why"


def test_the_topic_is_the_users_label(cases: list[dict[str, object]]) -> None:
    for case in (c for c in cases if c["author"] == "user"):
        label, _, _ = str(case["as_written"]).partition("->")
        assert case["topic"] == label.strip(), case["id"]


def test_no_case_repeats_a_topic_the_thresholds_were_fitted_to(
    data: dict[str, object], cases: list[dict[str, object]]
) -> None:
    fitting = data["threshold_fitting_topics"]
    fitted = {_normalise(t) for group in fitting.values() for t in group}  # type: ignore[union-attr]
    leaked = [c["id"] for c in cases if _normalise(str(c["topic"])) in fitted]

    assert not leaked, f"these cases were used to fit the thresholds: {leaked}"
