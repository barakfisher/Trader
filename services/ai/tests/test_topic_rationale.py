"""The rationale a topic candidate carries is quoted from its description, never written.

The descriptions below are written for the test, not copied from Yahoo: the
function is about text, and Yahoo's prose does not belong in a committed file
(see `app/universe/snapshot.py`).
"""

from __future__ import annotations

from app.topics.resolution import rationale

DESCRIPTION = (
    "Example Power Corp. designs modular light water reactors. "
    "It also sells engineering services to utilities. "
    "The company was founded in 2007 and is based in Oregon."
)


def test_the_sentence_sharing_the_most_words_with_the_topic_is_chosen() -> None:
    assert rationale("nuclear reactors", DESCRIPTION) == (
        "Example Power Corp. designs modular light water reactors."
    )


def test_a_singular_topic_meets_a_plural_in_the_description() -> None:
    # "service" folds to meet "services". Only a trailing -s is folded, so
    # "utility" does not meet "utilities": a known limit of a deliberately
    # crude rule, whose failure mode is the harmless first-sentence fallback.
    assert rationale("service", DESCRIPTION) == ("It also sells engineering services to utilities.")


def test_with_no_shared_word_the_first_sentence_is_quoted() -> None:
    assert (
        rationale("chips", DESCRIPTION)
        == "Example Power Corp. designs modular light water reactors."
    )


def test_the_rationale_is_always_a_verbatim_part_of_the_description() -> None:
    for topic in ("nuclear", "oregon founded", "services", "zzz", ""):
        assert rationale(topic, DESCRIPTION) in DESCRIPTION


def test_stopwords_alone_do_not_select_a_sentence() -> None:
    # "the company" shares only stopwords with the third sentence.
    assert rationale("the company", DESCRIPTION) == (
        "Example Power Corp. designs modular light water reactors."
    )
