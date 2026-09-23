"""Chunking, frontmatter and the content hash.

These are the rules that decide what a citation can point at, and they are pure,
so they are tested directly rather than through a database.

The hash tests are the load-bearing ones. Ingestion writes nothing when the hash
matches, so a hash that is insensitive to a change means an edit silently never
reaches the corpus - the failure would be invisible in the product and would look
like a stale cache. Each test below names one change and asserts the hash moves.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.corpus.documents import (
    Chunk,
    CorpusError,
    chunk_body,
    content_hash,
    load_directory,
    parse_document,
    parse_frontmatter,
)

DOCUMENT = """---
slug: drawdown
title: Drawdown
source: traders-curated
license: CC0-1.0
---

## What it is

A fall from a recent high.

## How it is computed

Latest price against the trailing high.
"""


def test_parses_frontmatter_into_fields_and_body() -> None:
    fields, body = parse_frontmatter(DOCUMENT)
    assert fields == {
        "slug": "drawdown",
        "title": "Drawdown",
        "source": "traders-curated",
        "license": "CC0-1.0",
    }
    assert body.lstrip().startswith("## What it is")


def test_a_document_without_frontmatter_is_refused() -> None:
    """An unlicensed document must not enter the corpus by saying nothing."""
    with pytest.raises(CorpusError, match="frontmatter"):
        parse_document("## What it is\n\nSomething.\n")


def test_missing_required_frontmatter_is_refused() -> None:
    text = DOCUMENT.replace("license: CC0-1.0\n", "")
    with pytest.raises(CorpusError, match="license"):
        parse_document(text)


def test_empty_required_frontmatter_is_refused() -> None:
    """Present-but-empty is the case a `key in fields` check would let through."""
    text = DOCUMENT.replace("license: CC0-1.0", "license:")
    with pytest.raises(CorpusError, match="license"):
        parse_document(text)


def test_chunks_follow_headings_and_are_numbered_from_one() -> None:
    chunks = chunk_body("\n## First\n\nAlpha.\n\n## Second\n\nBeta.\n")
    assert chunks == (
        Chunk(ord=1, heading="First", text="Alpha."),
        Chunk(ord=2, heading="Second", text="Beta."),
    )


def test_text_before_the_first_heading_becomes_chunk_zero() -> None:
    chunks = chunk_body("Standalone opening.\n\n## First\n\nAlpha.\n")
    assert chunks[0] == Chunk(ord=0, heading=None, text="Standalone opening.")
    assert chunks[1].ord == 1


def test_a_heading_with_no_body_is_dropped() -> None:
    """An empty chunk is retrievable and shows a heading with no answer."""
    chunks = chunk_body("## Empty\n\n## Full\n\nAlpha.\n")
    assert [c.heading for c in chunks] == ["Full"]


def test_subsections_stay_with_their_parent_section() -> None:
    """`###` is part of an answer, not an answer on its own."""
    chunks = chunk_body("## First\n\nAlpha.\n\n### Detail\n\nBeta.\n")
    assert len(chunks) == 1
    assert "### Detail" in chunks[0].text


def test_the_heading_is_not_folded_into_the_indexed_text() -> None:
    """`text_search` indexes `text`; the four shared headings would be noise."""
    (chunk,) = chunk_body("## What it is\n\nAlpha.\n")
    assert chunk.text == "Alpha."
    assert chunk.heading == "What it is"


def test_hash_is_stable_across_parses() -> None:
    assert parse_document(DOCUMENT).content_hash == parse_document(DOCUMENT).content_hash


def test_hash_changes_when_body_text_changes() -> None:
    edited = DOCUMENT.replace("A fall from a recent high.", "A fall from a recent high. More.")
    assert parse_document(edited).content_hash != parse_document(DOCUMENT).content_hash


def test_hash_changes_when_a_heading_changes() -> None:
    edited = DOCUMENT.replace("## How it is computed", "## How it is calculated")
    assert parse_document(edited).content_hash != parse_document(DOCUMENT).content_hash


def test_hash_changes_when_sections_are_reordered() -> None:
    """Order is part of what a citation points at, so it is part of the hash."""
    reordered = content_hash(
        (
            Chunk(ord=1, heading="Second", text="Beta."),
            Chunk(ord=2, heading="First", text="Alpha."),
        )
    )
    original = content_hash(
        (
            Chunk(ord=1, heading="First", text="Alpha."),
            Chunk(ord=2, heading="Second", text="Beta."),
        )
    )
    assert reordered != original


def test_hash_ignores_metadata() -> None:
    """A title typo must update the row without churning citable chunk ids."""
    retitled = DOCUMENT.replace("title: Drawdown", "title: Drawdown (corrected)")
    assert parse_document(retitled).content_hash == parse_document(DOCUMENT).content_hash


def test_hash_does_not_collide_across_a_chunk_boundary() -> None:
    """Two chunks must not hash the same as one chunk holding both texts."""
    split = content_hash(
        (Chunk(ord=1, heading=None, text="Alpha."), Chunk(ord=2, heading=None, text="Beta."))
    )
    joined = content_hash((Chunk(ord=1, heading=None, text="Alpha.\nBeta."),))
    assert split != joined


def test_the_real_corpus_parses() -> None:
    """The shipped documents are valid input to the ingester, not just to a reader."""
    corpus = Path(__file__).resolve().parents[3] / "data" / "corpus" / "concepts"
    documents = load_directory(corpus)

    assert len(documents) == 9
    assert all(document.namespace == "concepts" for document in documents)
    assert all(document.license for document in documents)
    # Four sections each, which is what the corpus contract test enforces.
    assert all(len(document.chunks) == 4 for document in documents)
    # Hashes must be distinct, or two documents would be indistinguishable to
    # the ingester's comparison.
    assert len({document.content_hash for document in documents}) == 9
