"""Every concept a rule names must have a document, and vice versa.

`CONCEPTS` in `app/narration/templates.py` is a claim: attaching `drawdown` to a
finding asserts that a reader who does not know the word can click through and
find out. Since M2 that claim has been false - the chips rendered as dead labels
because there was nothing on the other end of them, and PRD FR-16 ("one click to
an explanation") went unmet for two milestones.

The corpus now supplies the other end. This file is what stops the two drifting
apart again, in either direction:

  * a rule that starts naming a concept with no document puts a dead chip back
    in the feed - the original bug, reintroduced;
  * a document for a slug no rule emits is unreachable by design, and is either
    a typo in the filename or a concept that was renamed on one side only.

Both are silent failures in the product. Neither is visible in a unit test of
the rule that caused it, because the rule's own tests assert on the tuple it
emits rather than on whether that tuple points anywhere.

The structural assertions exist for the ingester, which chunks on `##` headings:
a document with no headings becomes one undifferentiated chunk, and a citation
that reads "section 2 of Drawdown" needs sections to count.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.narration.templates import CONCEPTS

REPO_ROOT = Path(__file__).resolve().parents[3]
CORPUS = REPO_ROOT / "data" / "corpus" / "concepts"

#: The four sections every concept document carries. Shared structure is what
#: lets a retrieved chunk be presented without knowing which document it is from.
REQUIRED_SECTIONS = (
    "What it is",
    "How it is computed",
    "How to read it",
    "Common misreadings",
)

#: Frontmatter keys the ingester reads. `license` is required because the corpus
#: is required to be licence-clean and an absent value must not pass silently.
REQUIRED_FRONTMATTER = ("slug", "title", "source", "license")

_FRONTMATTER = re.compile(r"\A---\n(?P<body>.*?)\n---\n", re.DOTALL)


def _referenced_slugs() -> set[str]:
    """Every concept slug any rule can attach to a finding."""
    return {slug for slugs in CONCEPTS.values() for slug in slugs}


def _documents() -> dict[str, str]:
    return {path.stem: path.read_text(encoding="utf-8") for path in sorted(CORPUS.glob("*.md"))}


def _frontmatter(text: str) -> dict[str, str]:
    match = _FRONTMATTER.match(text)
    assert match is not None, "document does not begin with a YAML frontmatter block"
    pairs = (line.split(":", 1) for line in match.group("body").splitlines() if ":" in line)
    return {key.strip(): value.strip() for key, value in pairs}


def test_every_referenced_concept_has_a_document() -> None:
    """A slug a rule emits with no document behind it is a dead chip."""
    missing = sorted(_referenced_slugs() - set(_documents()))
    assert not missing, (
        f"these concepts are attached to findings but have no document in {CORPUS}: "
        f"{missing}. A chip for them would render as a dead label, which is the "
        "condition FR-16 exists to remove."
    )


def test_every_document_is_reachable_from_a_rule() -> None:
    """A document no rule points at cannot be reached by clicking anything."""
    orphans = sorted(set(_documents()) - _referenced_slugs())
    assert not orphans, (
        f"these documents exist but no rule emits their slug: {orphans}. "
        "Either the filename is a typo, or the concept was renamed in "
        "templates.py and not here."
    )


def test_frontmatter_slug_matches_the_filename() -> None:
    """The filename is the lookup key; a disagreeing slug field misroutes it."""
    for slug, text in _documents().items():
        assert _frontmatter(text).get("slug") == slug, (
            f"{slug}.md declares a different slug in its frontmatter"
        )


def test_every_document_declares_its_provenance() -> None:
    """Licence and source are not optional: the corpus must be licence-clean."""
    for slug, text in _documents().items():
        frontmatter = _frontmatter(text)
        for key in REQUIRED_FRONTMATTER:
            value = frontmatter.get(key)
            assert value, f"{slug}.md is missing a non-empty `{key}` in its frontmatter"


def test_every_document_carries_the_standard_sections() -> None:
    """Shared structure, in order, so the ingester can chunk on it."""
    for slug, text in _documents().items():
        headings = tuple(re.findall(r"^## (.+)$", text, re.MULTILINE))
        assert headings == REQUIRED_SECTIONS, (
            f"{slug}.md has sections {headings}, expected {REQUIRED_SECTIONS}"
        )


def test_no_section_is_empty() -> None:
    """A heading with nothing under it chunks to a citation pointing at nothing."""
    for slug, text in _documents().items():
        parts = re.split(r"^## .+$", text, flags=re.MULTILINE)[1:]
        for heading, body in zip(REQUIRED_SECTIONS, parts, strict=True):
            assert body.strip(), f"{slug}.md has an empty section: {heading!r}"
