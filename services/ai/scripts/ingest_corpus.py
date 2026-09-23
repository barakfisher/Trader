"""Load the concept corpus into `kb_documents` / `kb_chunks`.

    python scripts/ingest_corpus.py [--dry-run] [--corpus PATH] [--prune]

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

Exits non-zero if any document fails to parse, and writes nothing in that case:
a corpus that is half licence-checked is not a corpus.
"""

from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

from sqlalchemy import text

from app.corpus.documents import CorpusError, load_directory
from app.corpus.ingest import ingest_documents
from app.db import get_engine

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CORPUS = REPO_ROOT / "data" / "corpus" / "concepts"


def main() -> int:
    parser = argparse.ArgumentParser(description="Ingest the concept corpus.")
    parser.add_argument("--dry-run", action="store_true", help="report changes, write nothing")
    parser.add_argument(
        "--corpus", type=Path, default=DEFAULT_CORPUS, help=f"directory (default: {DEFAULT_CORPUS})"
    )
    parser.add_argument("--prune", action="store_true", help="delete stored documents with no file")
    args = parser.parse_args()

    try:
        documents = load_directory(args.corpus)
    except CorpusError as error:
        print(f"error: {error}")
        return 1

    print(f"parsed {len(documents)} documents from {args.corpus}")

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
        return 0

    with engine.begin() as connection:
        results = ingest_documents(connection, documents)

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
    if removed_documents:
        print(f"pruned {removed_documents} documents with no file")

    for result in results:
        if result.outcome != "unchanged":
            print(f"  {result.slug}: {result.outcome}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
