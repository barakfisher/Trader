"""Turn a corpus markdown file into the rows the database expects.

Pure throughout: a path or a string goes in, a `CorpusDocument` comes out, and
nothing here opens a connection. The chunking rules are the part most likely to
be argued with later, and they should be arguable without a Postgres running.

**Chunking follows the document's own structure rather than a character count.**
A fixed-size window cuts sentences in half and glues the end of one idea to the
start of the next, which a reader then sees quoted back at them as an
explanation. These documents are written to a four-section shape - and a test
enforces it - so the sections are the natural unit: each one answers a single
question and stands on its own when shown alone.

The size-based fallback that a general ingester needs is deliberately absent.
Concept documents are hand-written to a known shape, so no section is anywhere
near large enough to need splitting. The `news` namespace will have ingested
article text of arbitrary length and no reliable headings, and that is the
change that should introduce a size rule - written against real articles rather
than guessed at now.

**The heading is stored beside the text, not inside it.** `kb_chunks.text_search`
indexes `text` only, and every concept document carries the same four headings,
so folding them into the indexed text would add the same four phrases to all
nine documents: pure noise in the ranking, and zero power to tell them apart.
The heading is kept because it is most of what tells a reader what they are
looking at when a chunk is shown on its own.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

#: A section boundary. Only `##` - `#` is the document title in a body that has
#: one, and `###` is a subsection that belongs with its parent section rather
#: than standing alone as an answer.
_HEADING = re.compile(r"^## +(.+?) *$", re.MULTILINE)

#: The frontmatter block, which must open the file. A document without one has
#: no licence, and an unlicensed document must not enter the corpus silently.
_FRONTMATTER = re.compile(r"\A---\n(?P<body>.*?)\n---\n(?P<rest>.*)\Z", re.DOTALL)

#: Frontmatter keys that must be present and non-empty.
REQUIRED_KEYS = ("slug", "title", "source", "license")

NAMESPACE_CONCEPTS = "concepts"


class CorpusError(ValueError):
    """A document that cannot be ingested, named so the operator can fix it."""


@dataclass(frozen=True, slots=True)
class Chunk:
    """One retrievable passage, and where in its document it came from."""

    ord: int
    heading: str | None
    text: str


@dataclass(frozen=True, slots=True)
class CorpusDocument:
    """A parsed document, ready to be compared against what is stored."""

    namespace: str
    concept_slug: str | None
    title: str
    source: str
    uri: str | None
    license: str
    chunks: tuple[Chunk, ...]
    content_hash: str


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Split a document into its frontmatter mapping and its body.

    A deliberately small parser rather than a YAML dependency: the frontmatter
    is four flat string keys, and accepting arbitrary YAML here would mean
    accepting structures the schema has nowhere to put.
    """
    match = _FRONTMATTER.match(text)
    if match is None:
        raise CorpusError("document does not open with a `---` frontmatter block")

    fields: dict[str, str] = {}
    for line in match.group("body").splitlines():
        if not line.strip():
            continue
        if ":" not in line:
            raise CorpusError(f"frontmatter line is not `key: value`: {line!r}")
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip()

    return fields, match.group("rest")


def chunk_body(body: str) -> tuple[Chunk, ...]:
    """Split a document body into one chunk per `##` section.

    Text before the first heading becomes chunk 0 with no heading, so a document
    that opens with a paragraph does not lose it. Headed sections are numbered
    from 1, which makes `ord` read the way a citation does: chunk 2 is the
    second section.

    A section with a heading and no body is dropped rather than stored. An empty
    chunk is retrievable, ranks against nothing and shows the reader a heading
    with no answer under it.
    """
    matches = list(_HEADING.finditer(body))

    chunks: list[Chunk] = []
    preamble = body[: matches[0].start()] if matches else body
    if preamble.strip():
        chunks.append(Chunk(ord=0, heading=None, text=preamble.strip()))

    for position, match in enumerate(matches, start=1):
        end = matches[position].start() if position < len(matches) else len(body)
        text = body[match.end() : end].strip()
        if not text:
            continue
        chunks.append(Chunk(ord=position, heading=match.group(1), text=text))

    return tuple(chunks)


def content_hash(chunks: tuple[Chunk, ...]) -> str:
    """A stable digest of everything that would be written to `kb_chunks`.

    Covers the chunk text, its heading and its position, because a change to any
    of the three changes what a citation points at. It deliberately does *not*
    cover the title, source, uri or licence: those live on the document row, and
    correcting a typo in a title should update that row without rewriting chunks
    and churning the ids that citations are made of.
    """
    material = "\n".join(f"{c.ord}|{c.heading or ''}|{c.text}" for c in chunks)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def parse_document(text: str, *, namespace: str = NAMESPACE_CONCEPTS) -> CorpusDocument:
    """Parse one document's text. Raises `CorpusError` with the reason."""
    fields, body = parse_frontmatter(text)

    missing = [key for key in REQUIRED_KEYS if not fields.get(key)]
    if missing:
        raise CorpusError(f"frontmatter is missing or empty: {', '.join(missing)}")

    chunks = chunk_body(body)
    if not chunks:
        raise CorpusError("document has no content to chunk")

    return CorpusDocument(
        namespace=namespace,
        # Outside `concepts` a document explains nothing in particular, and the
        # schema stores null rather than a slug nothing will ever look up.
        concept_slug=fields["slug"] if namespace == NAMESPACE_CONCEPTS else None,
        title=fields["title"],
        source=fields["source"],
        uri=fields.get("uri") or None,
        license=fields["license"],
        chunks=chunks,
        content_hash=content_hash(chunks),
    )


def load_document(path: Path, *, namespace: str = NAMESPACE_CONCEPTS) -> CorpusDocument:
    """Parse the file at `path`, checking the filename against the slug.

    The filename is what an observation's `concept_refs` resolves against, so a
    frontmatter slug that disagrees with it would make the document reachable
    under a name no rule emits.
    """
    try:
        document = parse_document(path.read_text(encoding="utf-8"), namespace=namespace)
    except CorpusError as error:
        raise CorpusError(f"{path.name}: {error}") from error

    if namespace == NAMESPACE_CONCEPTS and document.concept_slug != path.stem:
        raise CorpusError(
            f"{path.name}: frontmatter slug {document.concept_slug!r} does not match the filename"
        )
    return document


def load_directory(directory: Path, *, namespace: str = NAMESPACE_CONCEPTS) -> list[CorpusDocument]:
    """Every `.md` file in `directory`, in filename order."""
    paths = sorted(directory.glob("*.md"))
    if not paths:
        raise CorpusError(f"no documents found in {directory}")
    return [load_document(path, namespace=namespace) for path in paths]
