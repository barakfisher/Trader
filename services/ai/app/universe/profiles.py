"""`instrument_profiles`: loading the universe into it, embedding it, searching it.

The same three rules as the concept corpus (`app/corpus/ingest.py`), applied to
a different table for the reason migration 0014 gives:

- **Compare before writing.** A profile whose matching-text hash is unchanged
  keeps its embedding; only size facts are refreshed. Re-running the load on an
  unchanged snapshot therefore embeds nothing and costs nothing.
- **A vector never outlives its text.** The statement that changes a
  description nulls its embedding, so "needs embedding" is `embedding IS NULL`
  or "made by another model", and there is no third case.
- **The model is stored beside the vector**, and search filters on it, because
  vectors from two models are the same width and mean nothing to each other.

Existing `instruments` rows are never overwritten: a holding's instrument may
already carry a name or asset class the user's own data established, and the
universe only fills what is missing.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.corpus.embeddings import BaseEmbedder, Embedding
from app.corpus.vector_store import to_pgvector
from app.universe.matching_text import MATCHING_TEXT_VERSION, matching_text
from app.universe.snapshot import Snapshot, UniverseInstrument

#: Where the description text came from, and on what terms. Written to every
#: row; see migration 0014 for why the licence is a column at all.
DESCRIPTION_SOURCE = "yahoo-finance:longBusinessSummary"
DESCRIPTION_LICENSE = (
    "Yahoo Finance business summary. Fetched per installation for matching only; "
    "not redistributed and not committed."
)

#: Descriptions per embedding request. Bounded so one failed call loses a
#: batch, not the universe, and so a request stays well inside provider limits.
EMBED_BATCH = 100


@dataclass(frozen=True, slots=True)
class LoadReport:
    created: int
    text_changed: int
    unchanged: int
    #: Members with no description on this machine: they can never be a
    #: candidate, and the number says how much of the universe that is.
    undescribed: int
    #: Members skipped because Yahoo reported no currency, which `instruments`
    #: requires and which is not ours to guess.
    no_currency: int


@dataclass(frozen=True, slots=True)
class ProfileMatch:
    instrument_id: str
    symbol: str
    name: str | None
    asset_class: str
    sector: str | None
    industry: str | None
    category: str | None
    description: str
    #: Cosine similarity in [-1, 1]; rises with relevance.
    similarity: float
    #: Market cap for an equity, net assets for an ETF, in minor units of the
    #: listing currency; None when the snapshot had neither.
    size_minor: int | None
    #: The stored description vector. Carried so a caller can compare
    #: candidates with each other, not only with the query.
    embedding: Embedding


def content_hash(text_to_embed: str) -> str:
    """Of the embedded text and the rule that produced it, so a rule change re-embeds."""
    return hashlib.sha256(f"{MATCHING_TEXT_VERSION}\n{text_to_embed}".encode()).hexdigest()


def _upsert_instrument(connection: Connection, member: UniverseInstrument) -> str:
    return str(
        connection.execute(
            text(
                """
                INSERT INTO instruments (symbol, asset_class, exchange, currency, name)
                VALUES (:symbol, :asset_class, :exchange, :currency, :name)
                ON CONFLICT (symbol) DO UPDATE
                   SET name        = COALESCE(instruments.name, EXCLUDED.name),
                       exchange    = COALESCE(instruments.exchange, EXCLUDED.exchange),
                       asset_class = CASE WHEN instruments.asset_class = 'unknown'
                                          THEN EXCLUDED.asset_class
                                          ELSE instruments.asset_class END
                RETURNING id
                """
            ),
            {
                "symbol": member.symbol,
                "asset_class": member.asset_class,
                "exchange": member.exchange,
                "currency": member.currency,
                "name": member.name,
            },
        ).scalar_one()
    )


def load_universe(connection: Connection, snapshot: Snapshot) -> LoadReport:
    """Write every described member's instrument row and profile, in one transaction."""
    existing = {
        str(row.instrument_id): row.content_hash
        for row in connection.execute(
            text("SELECT instrument_id, content_hash FROM instrument_profiles")
        )
    }
    as_of = datetime.fromisoformat(snapshot.as_of.replace("Z", "+00:00"))
    created = changed = unchanged = undescribed = no_currency = 0

    for member in snapshot.instruments:
        if member.description is None:
            undescribed += 1
            continue
        if member.currency is None:
            no_currency += 1
            continue
        instrument_id = _upsert_instrument(connection, member)
        embedded_text = matching_text(member.name, member.asset_class, member.description)
        digest = content_hash(embedded_text)
        previous = existing.get(instrument_id)
        if previous is None:
            created += 1
        elif previous != digest:
            changed += 1
        else:
            unchanged += 1

        connection.execute(
            text(
                """
                INSERT INTO instrument_profiles (
                    instrument_id, description, matching_text, source, license, content_hash,
                    sector, industry, category,
                    market_cap_minor, net_assets_minor, size_currency, size_as_of
                ) VALUES (
                    :instrument_id, :description, :matching_text, :source, :license, :hash,
                    :sector, :industry, :category,
                    :market_cap_minor, :net_assets_minor, :currency, :as_of
                )
                ON CONFLICT (instrument_id) DO UPDATE
                   SET description      = EXCLUDED.description,
                       matching_text    = EXCLUDED.matching_text,
                       source           = EXCLUDED.source,
                       license          = EXCLUDED.license,
                       sector           = EXCLUDED.sector,
                       industry         = EXCLUDED.industry,
                       category         = EXCLUDED.category,
                       market_cap_minor = EXCLUDED.market_cap_minor,
                       net_assets_minor = EXCLUDED.net_assets_minor,
                       size_currency    = EXCLUDED.size_currency,
                       size_as_of       = EXCLUDED.size_as_of,
                       -- The vector survives only if the text it describes did.
                       embedding        = CASE
                           WHEN instrument_profiles.content_hash = EXCLUDED.content_hash
                           THEN instrument_profiles.embedding END,
                       embedding_model  = CASE
                           WHEN instrument_profiles.content_hash = EXCLUDED.content_hash
                           THEN instrument_profiles.embedding_model END,
                       content_hash     = EXCLUDED.content_hash,
                       updated_at       = now()
                """
            ),
            {
                "instrument_id": instrument_id,
                "description": member.description,
                "matching_text": embedded_text,
                "source": DESCRIPTION_SOURCE,
                "license": DESCRIPTION_LICENSE,
                "hash": digest,
                "sector": member.sector,
                "industry": member.industry,
                "category": member.category,
                "market_cap_minor": member.market_cap_minor,
                "net_assets_minor": member.net_assets_minor,
                "currency": member.currency,
                "as_of": as_of,
            },
        )

    return LoadReport(created, changed, unchanged, undescribed, no_currency)


async def embed_pending(connection: Connection, embedder: BaseEmbedder) -> int:
    """Embed every profile with no vector from `embedder.model`. Returns how many."""
    pending = connection.execute(
        text(
            """
            SELECT instrument_id, matching_text
              FROM instrument_profiles
             WHERE embedding IS NULL OR embedding_model IS DISTINCT FROM :model
             ORDER BY instrument_id
            """
        ),
        {"model": embedder.model},
    ).all()

    written = 0
    for start in range(0, len(pending), EMBED_BATCH):
        batch = pending[start : start + EMBED_BATCH]
        vectors = await embedder.embed_documents([row.matching_text for row in batch])
        for row, vector in zip(batch, vectors, strict=True):
            connection.execute(
                text(
                    """
                    UPDATE instrument_profiles
                       SET embedding = CAST(:embedding AS vector), embedding_model = :model
                     WHERE instrument_id = :id
                    """
                ),
                {
                    "id": row.instrument_id,
                    "embedding": to_pgvector(vector),
                    "model": embedder.model,
                },
            )
            written += 1
    return written


def search_profiles(
    connection: Connection, *, embedding: Embedding, model: str, limit: int
) -> list[ProfileMatch]:
    """The `limit` profiles nearest to `embedding`, most similar first.

    `model` is required, unlike `VectorStore.search`: there is no operator use
    for ranking a topic against vectors from an unknown model, and it is the
    one way this table returns confident nonsense.

    `hnsw.ef_search` is raised for this transaction because an HNSW scan
    returns at most that many rows (default 40) whatever the LIMIT says: asking
    for 50 would silently return 40, and a recall measured at 50 would really be
    a recall at 40. `SET LOCAL` does not take a bind parameter, hence the int().
    """
    connection.execute(text(f"SET LOCAL hnsw.ef_search = {max(int(limit), 40)}"))
    rows = connection.execute(
        text(
            """
            SELECT p.instrument_id, i.symbol, i.name, i.asset_class,
                   p.sector, p.industry, p.category, p.description,
                   COALESCE(p.market_cap_minor, p.net_assets_minor) AS size_minor,
                   p.embedding::text AS embedding,
                   1 - (p.embedding <=> CAST(:embedding AS vector)) AS similarity
              FROM instrument_profiles p
              JOIN instruments i ON i.id = p.instrument_id
             WHERE p.embedding_model = :model
             ORDER BY p.embedding <=> CAST(:embedding AS vector)
             LIMIT :limit
            """
        ),
        {"embedding": to_pgvector(embedding), "model": model, "limit": limit},
    ).all()
    return [
        ProfileMatch(
            instrument_id=str(row.instrument_id),
            symbol=row.symbol,
            name=row.name,
            asset_class=row.asset_class,
            sector=row.sector,
            industry=row.industry,
            category=row.category,
            description=row.description,
            similarity=float(row.similarity),
            size_minor=row.size_minor,
            # pgvector renders a vector as '[x,y,...]', which is valid JSON.
            embedding=json.loads(row.embedding),
        )
        for row in rows
    ]
