"""Load the concept corpus into `kb_documents` / `kb_chunks`.

    python scripts/ingest_corpus.py [--dry-run] [--corpus PATH] [--prune] [--no-embed]

Run it after editing anything under `data/corpus/concepts/`, and once on a fresh
environment. It is safe to run repeatedly: a document whose content has not
changed is compared and then left alone, so a second run in a row writes
nothing at all. That property is the point of the content hash, and it is what
lets this be wired into a boot sequence later without churning the chunk ids
that citations are made of.

`--dry-run` reports what would change without opening a write transaction, which
is the fast way to answer "is the database in step with the files?".

`--prune` deletes stored documents that no longer have a file. It is off by
default because the destructive reading of an empty directory - "delete
everything" - must not be the accident that a mistyped `--corpus` produces.

Embedding runs by default, in the same transaction as the ingestion, and is
idempotent in the same way: a chunk that already carries a vector from the
configured model is not re-embedded. `--no-embed` skips it, for an operator who
wants the text loaded without waiting on - or paying for - a provider. The
resulting state is legitimate and visible rather than broken: concept chips work,
because a chip is a slug lookup, and search reports every match with a null
`vector_rank` because only its full-text half ran.

Exits non-zero if any document fails to parse, and writes nothing in that case:
a corpus that is half licence-checked is not a corpus.
"""

from __future__ import annotations

import argparse
import asyncio
from collections import Counter
from pathlib import Path

from sqlalchemy import text

from app.config import get_settings
from app.corpus.documents import CorpusError, load_directory
from app.corpus.embedder_factory import EmbedderConfigurationError, build_embedder
from app.corpus.ingest import embed_pending, ingest_documents
from app.corpus.vector_store import PgVectorStore
from app.db import get_engine


def default_corpus() -> Path:
    """The `concepts` namespace inside whichever corpus this runtime has.

    Resolved through `Settings.corpus_dir` rather than from this file's own
    location, because the script runs from a checkout *and* from /app inside the
    migrate container, where a repo-relative guess raises IndexError.
    """
    return Path(get_settings().corpus_dir) / "concepts"


def main() -> int:
    parser = argparse.ArgumentParser(description="Ingest the concept corpus.")
    parser.add_argument("--dry-run", action="store_true", help="report changes, write nothing")
    parser.add_argument(
        "--corpus",
        type=Path,
        default=None,
        help="directory to ingest (default: the `concepts` namespace of CORPUS_DIR)",
    )
    parser.add_argument("--prune", action="store_true", help="delete stored documents with no file")
    parser.add_argument(
        "--no-embed",
        action="store_true",
        help="load text only; leave chunks without vectors",
    )
    args = parser.parse_args()
    corpus = args.corpus or default_corpus()

    try:
        documents = load_directory(corpus)
    except CorpusError as error:
        print(f"error: {error}")
        return 1

    print(f"parsed {len(documents)} documents from {corpus}")

    # Every statement below is scoped to the namespace being ingested. Without
    # it, a `news` document - which carries a null `concept_slug` by design -
    # is read as an orphaned concept, and `--prune` would be a command that
    # deletes ingested articles as a side effect of loading definitions.
    namespace = documents[0].namespace
    engine = get_engine()

    if args.dry_run:
        # Read-only, and deliberately not a transaction that writes and rolls
        # back: a dry run must not be able to leave anything behind.
        with engine.connect() as connection:
            stored = {
                row.concept_slug: row.content_hash
                for row in connection.execute(
                    text(
                        """
                        SELECT concept_slug, content_hash
                          FROM kb_documents
                         WHERE namespace = :namespace
                        """
                    ),
                    {"namespace": namespace},
                )
            }
        counts: Counter[str] = Counter()
        for document in documents:
            current = stored.get(document.concept_slug)
            if current is None:
                counts["would create"] += 1
            elif current != document.content_hash:
                counts["would update"] += 1
            else:
                counts["unchanged"] += 1
        orphans = sorted(set(stored) - {d.concept_slug for d in documents})
        for label, count in sorted(counts.items()):
            print(f"  {label}: {count}")
        if orphans:
            print(f"  stored with no file: {', '.join(orphans)}")

        # An embedding is a second derived copy of the same text, and slice 1's
        # lesson was that a derived copy nobody can interrogate drifts silently.
        # So the question this flag answers - "is the database in step with the
        # files?" - has to cover vectors as well as text, or it answers half of
        # itself and reads as if it answered all of it.
        with engine.connect() as connection:
            coverage = PgVectorStore().coverage(connection, namespace=namespace)
        models = ", ".join(coverage.models) if coverage.models else "none"
        print(f"  embedded chunks: {coverage.embedded}/{coverage.total} (models: {models})")
        if coverage.pending:
            print(f"  would embed: {coverage.pending}")
        return 0

    if args.no_embed:
        embedder = None
    else:
        try:
            embedder = build_embedder(get_settings())
        except EmbedderConfigurationError as error:
            # Refused before a write transaction is opened, so a bad setting
            # leaves the corpus exactly as it was rather than loading the text
            # and then failing on the vectors - which would be the half-embedded
            # state this whole design exists to make impossible.
            print(f"error: {error}")
            return 1

    embedded = 0
    with engine.begin() as connection:
        results = ingest_documents(connection, documents)

        # Same transaction as the ingestion above, deliberately. A crash between
        # two transactions would leave chunks whose vectors describe the text
        # they replaced; inside one, the corpus is either wholly updated or
        # wholly untouched.
        if embedder is not None:
            embedded = asyncio.run(
                embed_pending(connection, PgVectorStore(), embedder, namespace=namespace)
            ).chunks_embedded

        removed_documents = 0
        if args.prune:
            slugs = [d.concept_slug for d in documents]
            removed = connection.execute(
                text(
                    """
                    DELETE FROM kb_documents
                     WHERE namespace = :namespace
                       AND concept_slug <> ALL(:slugs)
                    """
                ),
                {"namespace": namespace, "slugs": slugs},
            )
            removed_documents = removed.rowcount if removed.rowcount > 0 else 0

    counts = Counter(result.outcome for result in results)
    chunks_written = sum(result.chunks_written for result in results)
    chunks_removed = sum(result.chunks_removed for result in results)

    for outcome in ("created", "updated", "metadata", "unchanged"):
        if counts[outcome]:
            print(f"  {outcome}: {counts[outcome]}")
    print(f"chunks written: {chunks_written}, chunks removed: {chunks_removed}")
    if embedder is None:
        print("embedding skipped (--no-embed); search will run on its full-text half only")
    else:
        print(f"chunks embedded: {embedded} (model: {embedder.model})")
    if removed_documents:
        print(f"pruned {removed_documents} documents with no file")

    for result in results:
        if result.outcome != "unchanged":
            print(f"  {result.slug}: {result.outcome}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
