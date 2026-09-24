"""The eval file itself, checked without a database.

`scripts/run_eval.py` needs Postgres and runs in the compose job; this runs
everywhere, on every PR, and guards the properties that would make the eval
quietly meaningless rather than visibly broken.

**The one that matters most is disjointness.** `relevance.py`'s thresholds were
chosen from sixteen questions, and the lexical switch from six more. An eval
that included any of them would be testing the thresholds on the data that
picked them, which measures nothing and looks exactly like a pass. The fitting
questions are listed in the eval file, and this test fails if a case repeats one.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
EVAL = ROOT / "data" / "eval" / "ask.json"
CORPUS = ROOT / "data" / "corpus" / "concepts"

KNOWN_REFUSALS = {"not_in_corpus", "no_holdings", "not_computable", "advice"}
KNOWN_TIERS = {"keyless", "keyed"}


def _normalise(question: str) -> str:
    return re.sub(r"\s+", " ", question.lower().strip())


@pytest.fixture(scope="module")
def data() -> dict[str, object]:
    return json.loads(EVAL.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def cases(data: dict[str, object]) -> list[dict[str, object]]:
    return data["cases"]  # type: ignore[return-value]


def test_no_case_repeats_a_question_the_thresholds_were_fitted_to(
    data: dict[str, object], cases: list[dict[str, object]]
) -> None:
    fitted = {_normalise(q) for q in data["threshold_fitting_questions"]}  # type: ignore[union-attr]
    leaked = [c["id"] for c in cases if _normalise(str(c["question"])) in fitted]

    assert not leaked, f"these cases were used to fit the thresholds: {leaked}"


def test_case_ids_and_questions_are_unique(cases: list[dict[str, object]]) -> None:
    ids = [c["id"] for c in cases]
    questions = [_normalise(str(c["question"])) for c in cases]

    assert len(ids) == len(set(ids))
    assert len(questions) == len(set(questions))


def test_every_expected_concept_has_a_document(cases: list[dict[str, object]]) -> None:
    """A case expecting a slug nothing defines can never pass, and would read as
    a retrieval failure rather than as a typo in the eval file."""
    available = {path.stem for path in CORPUS.glob("*.md")}
    for case in cases:
        missing = set(case["expect"].get("slugs", [])) - available  # type: ignore[union-attr]
        assert not missing, f"{case['id']} expects {missing}"


def test_every_case_names_a_known_outcome(cases: list[dict[str, object]]) -> None:
    for case in cases:
        expect = case["expect"]
        assert isinstance(expect, dict) and expect, case["id"]
        if "refused" in expect:
            assert expect["refused"] in KNOWN_REFUSALS, case["id"]
        assert set(case["tiers"]) <= KNOWN_TIERS, case["id"]  # type: ignore[arg-type]
        assert case["intent"] in {"concept", "portfolio"}, case["id"]


def test_the_keyless_tier_never_asserts_a_corpus_refusal(
    cases: list[dict[str, object]],
) -> None:
    """The floor abstains on the fixture embedder, by design.

    A keyless `not_in_corpus` case would assert something that cannot happen in
    the environment it runs in - and would fail every PR for a reason unrelated
    to the change being reviewed.
    """
    for case in cases:
        if "keyless" in case["tiers"]:  # type: ignore[operator]
            assert case["expect"].get("refused") != "not_in_corpus", case["id"]  # type: ignore[union-attr]
            assert not case["expect"].get("hedged"), case["id"]  # type: ignore[union-attr]


def test_the_set_is_the_size_the_milestone_asked_for(cases: list[dict[str, object]]) -> None:
    """MILESTONES.md: "Small eval set (~30 Q/A)". A floor, not a target."""
    assert len(cases) >= 30
