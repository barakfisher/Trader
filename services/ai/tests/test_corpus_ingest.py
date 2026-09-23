"""Which branch ingestion takes for a given stored state.

**What this file proves, and what it does not.** The suite is hermetic - there is
no Postgres in CI - so the connection here is a fake that records the statements
it is handed. That is enough to pin the *decision*: unchanged content must reach
no UPDATE, a metadata-only edit must not rewrite chunks, and changed content
must. It is not enough to prove the SQL is correct, and it is not claimed to be.

The SQL itself is exercised by running `scripts/ingest_corpus.py` against a real
database, where the properties that matter were checked directly rather than
through the script's own output: re-ingesting an unchanged corpus left all 36
chunk ids and every `updated_at` byte-identical, and editing one section of one
document rewrote exactly one chunk row while the other three kept their ids.

The fake's row shape is built from the same column names the SELECT asks for, so
a rename in the query that this file did not follow shows up as an
`AttributeError` here rather than as a passing test of a stale contract.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

import pytest

from app.corpus.documents import NAMESPACE_CONCEPTS, Chunk, CorpusDocument, content_hash
from app.corpus.embeddings import EmbeddingError
from app.corpus.hashed_embedder import HashedEmbedder
from app.corpus.ingest import embed_pending, ingest_document
from app.corpus.vector_store import EmbeddingCoverage, PendingChunk


@dataclass(frozen=True)
class StoredRow:
    """The columns `ingest_document` selects, in the shape SQLAlchemy returns."""

    id: str
    content_hash: str
    title: str
    source: str
    uri: str | None
    license: str


class FakeResult:
    def __init__(self, row: object = None, rowcount: int = 1) -> None:
        self._row = row
        self.rowcount = rowcount

    def one_or_none(self) -> object:
        return self._row

    def scalar_one(self) -> object:
        return self._row


class FakeConnection:
    """Records every statement, and answers the first SELECT with `stored`."""

    def __init__(self, stored: StoredRow | None) -> None:
        self._stored = stored
        self.statements: list[str] = []

    def execute(self, statement: object, parameters: object = None) -> FakeResult:
        sql = " ".join(str(statement).split())
        self.statements.append(sql)
        if sql.startswith("SELECT id, content_hash"):
            return FakeResult(self._stored)
        if sql.startswith("INSERT INTO kb_documents"):
            return FakeResult("new-document-id")
        return FakeResult(None, rowcount=1)


def _document(*, title: str = "Drawdown", body: str = "A fall.") -> CorpusDocument:
    chunks = (Chunk(ord=1, heading="What it is", text=body),)
    return CorpusDocument(
        namespace="concepts",
        concept_slug="drawdown",
        title=title,
        source="traders-curated",
        uri=None,
        license="CC0-1.0",
        chunks=chunks,
        content_hash=content_hash(chunks),
    )


def _stored_from(document: CorpusDocument) -> StoredRow:
    return StoredRow(
        id="existing-id",
        content_hash=document.content_hash,
        title=document.title,
        source=document.source,
        uri=document.uri,
        license=document.license,
    )


def test_a_new_document_is_inserted_with_its_chunks() -> None:
    document = _document()
    connection = FakeConnection(stored=None)

    result = ingest_document(connection, document)

    assert result.outcome == "created"
    assert any(sql.startswith("INSERT INTO kb_documents") for sql in connection.statements)
    assert any(sql.startswith("INSERT INTO kb_chunks") for sql in connection.statements)


def test_an_unchanged_document_is_compared_and_not_written() -> None:
    """The property that makes re-running safe: no statement but the SELECT."""
    document = _document()
    connection = FakeConnection(stored=_stored_from(document))

    result = ingest_document(connection, document)

    assert result.outcome == "unchanged"
    assert len(connection.statements) == 1
    assert connection.statements[0].startswith("SELECT")
    assert result.chunks_written == 0


def test_a_metadata_only_edit_updates_the_row_and_leaves_chunks_alone() -> None:
    """Correcting a title must not churn the chunk ids citations are made of."""
    document = _document(title="Drawdown (corrected)")
    stored = _stored_from(document)
    connection = FakeConnection(stored=StoredRow(**{**stored.__dict__, "title": "Drawdown"}))

    result = ingest_document(connection, document)

    assert result.outcome == "metadata"
    assert any(sql.startswith("UPDATE kb_documents") for sql in connection.statements)
    assert not any("kb_chunks" in sql for sql in connection.statements)


def test_changed_content_updates_the_row_and_rewrites_chunks() -> None:
    document = _document(body="A fall, revised.")
    stale = _stored_from(_document(body="A fall."))
    connection = FakeConnection(stored=stale)

    result = ingest_document(connection, document)

    assert result.outcome == "updated"
    assert any(sql.startswith("UPDATE kb_documents") for sql in connection.statements)
    assert any(sql.startswith("INSERT INTO kb_chunks") for sql in connection.statements)
    # Chunks beyond the new end are removed, so a shortened document does not
    # leave an orphaned section behind that retrieval could still return.
    assert any(sql.startswith("DELETE FROM kb_chunks") for sql in connection.statements)


def test_a_changed_document_is_never_deleted_wholesale() -> None:
    """Upsert-by-position, not delete-and-reinsert: ids survive an edit."""
    document = _document(body="A fall, revised.")
    connection = FakeConnection(stored=_stored_from(_document(body="A fall.")))

    ingest_document(connection, document)

    assert not any(sql.startswith("DELETE FROM kb_documents") for sql in connection.statements)
    inserts = [sql for sql in connection.statements if sql.startswith("INSERT INTO kb_chunks")]
    assert all("ON CONFLICT (document_id, ord) DO UPDATE" in sql for sql in inserts)


# --------------------------------------------------------------------------
# The embedding pass
# --------------------------------------------------------------------------


class RecordingStore:
    """A `VectorStore` that hands out `pending` once and records what it is given."""

    def __init__(self, pending: list[PendingChunk]) -> None:
        self._pending = pending
        self.asked_for_model: str | None = None
        self.batches: list[list[tuple[str, list[float]]]] = []

    def pending_chunks(self, _connection, *, model, namespace=NAMESPACE_CONCEPTS):  # type: ignore[no-untyped-def]
        self.asked_for_model = model
        return self._pending

    def store_embeddings(self, _connection, *, model, embeddings):  # type: ignore[no-untyped-def]
        self.batches.append(embeddings)
        return len(embeddings)

    def search(self, _connection, **_kwargs):  # type: ignore[no-untyped-def]
        return []

    def coverage(self, _connection, **_kwargs):  # type: ignore[no-untyped-def]
        return EmbeddingCoverage(total=0, embedded=0, models=())


class ShortEmbedder:
    """Returns fewer vectors than it was given texts - the misattribution case."""

    model = "broken/short"
    dimension = 4
    charges_per_token = False

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [[1.0, 0.0, 0.0, 0.0]] * (len(texts) - 1)

    async def embed_query(self, text: str) -> list[float]:
        return [1.0, 0.0, 0.0, 0.0]


def test_nothing_pending_means_no_statements_at_all() -> None:
    """The same idempotence the content hash buys for text, bought for vectors.

    Embedding runs on every stack start, so a run that finds nothing to do must
    cost nothing - and must not touch `embedding_model`, which is what decides
    what needs re-embedding next time.
    """
    store = RecordingStore([])

    result = asyncio.run(embed_pending(FakeConnection(None), store, HashedEmbedder()))

    assert result.chunks_embedded == 0
    assert store.batches == []


def test_pending_chunks_are_requested_for_this_embedders_model() -> None:
    """A row embedded by another model is stale, even though it has a vector."""
    store = RecordingStore([])

    asyncio.run(embed_pending(FakeConnection(None), store, HashedEmbedder()))

    assert store.asked_for_model == HashedEmbedder.model


def test_every_pending_chunk_is_embedded_and_paired_with_its_own_id() -> None:
    pending = [PendingChunk(id=f"chunk-{n}", text=f"text {n}") for n in range(3)]
    store = RecordingStore(pending)

    result = asyncio.run(embed_pending(FakeConnection(None), store, HashedEmbedder()))

    assert result.chunks_embedded == 3
    assert [chunk_id for batch in store.batches for chunk_id, _ in batch] == [
        "chunk-0",
        "chunk-1",
        "chunk-2",
    ]


def test_batching_covers_every_chunk_without_repeating_one() -> None:
    """Batching exists for a paid provider's per-request charge, not for speed.

    It is at this layer rather than inside an adapter so the fixture inherits it
    unchanged - which is the only way a bug in the batching shows up in a suite
    that never calls a paid provider.
    """
    pending = [PendingChunk(id=f"chunk-{n}", text=f"text {n}") for n in range(7)]
    store = RecordingStore(pending)

    result = asyncio.run(embed_pending(FakeConnection(None), store, HashedEmbedder(), batch_size=3))

    assert [len(batch) for batch in store.batches] == [3, 3, 1]
    assert result.chunks_embedded == 7


def test_a_provider_returning_the_wrong_number_of_vectors_is_refused() -> None:
    """Zipping them would index every chunk after the gap under its neighbour.

    A corpus where `drawdown` is stored under `rebalancing`'s vector is wrong in
    a way nothing downstream can distinguish from a bad embedding model, so it
    is refused at the seam where the counts are still visible.
    """
    store = RecordingStore([PendingChunk(id="a", text="x"), PendingChunk(id="b", text="y")])

    with pytest.raises(EmbeddingError, match="returned 1 vectors for 2 texts"):
        asyncio.run(embed_pending(FakeConnection(None), store, ShortEmbedder()))

    assert store.batches == [], "nothing is written when the counts disagree"


def test_rewriting_a_chunks_text_clears_the_vector_that_described_it() -> None:
    """Otherwise retrieval ranks on a paragraph the document no longer contains.

    Cleared in the same statement that rewrites the text rather than by a later
    pass, which is what makes `embedding IS NULL` the complete definition of
    "needs embedding" instead of one of two conditions somebody has to remember.
    """
    document = _document(body="A different fall.")
    stored = _stored_from(_document())
    connection = FakeConnection(stored)

    ingest_document(connection, document)

    upsert = next(s for s in connection.statements if s.startswith("INSERT INTO kb_chunks"))
    assert "embedding = CASE WHEN kb_chunks.text IS DISTINCT FROM EXCLUDED.text" in upsert
    assert "embedding_model = CASE WHEN kb_chunks.text IS DISTINCT FROM EXCLUDED.text" in upsert
