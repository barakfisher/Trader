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

from dataclasses import dataclass

from app.corpus.documents import Chunk, CorpusDocument, content_hash
from app.corpus.ingest import ingest_document


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
