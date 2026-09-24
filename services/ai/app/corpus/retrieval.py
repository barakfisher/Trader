"""Hybrid retrieval: pgvector cosine and Postgres full-text, fused by rank.

DESIGN.md specifies "pgvector cosine + Postgres full-text, reciprocal-rank fused,
then a small reranker". Everything but the reranker is here; the reranker is
deliberately slice 3's, because it reorders a candidate list and there is no way
to tell a good reordering from a bad one until slice 4's eval set exists. Adding
one now would be a component nothing can measure, sitting on the one path where
being subtly wrong looks exactly like being right.

**Why fuse by rank rather than by score.** The two halves return numbers that are
not comparable and not even on the same kind of scale: cosine similarity is
bounded in [-1, 1] and tends to sit in a narrow band, while `ts_rank_cd` is
unbounded, depends on document length and on how many query terms matched, and
has no defined maximum. Normalising them onto a common scale requires knowing
each one's distribution, which varies per query - so a weighted sum of the two
silently re-weights itself depending on what was asked. Reciprocal rank fusion
throws the scores away and keeps only the order, which is the part both halves
agree about the meaning of.

    RRF(chunk) = sum over halves of 1 / (k + rank)

**`k` is a flattener, and its value is the one tuning number here.** At k=60, the
published default from the original RRF paper and what most implementations use,
the gap between rank 1 and rank 2 is small enough that a chunk both halves rank
second beats a chunk one half ranks first and the other does not return at all.
That is the behaviour wanted: agreement between two different notions of
relevance is stronger evidence than a single confident ranker, especially while
one of the two halves is a placeholder that ranks by word overlap.

**The vector half is currently a placeholder and this module says so in its
output.** `HybridResult.vector_is_semantic` is False whenever the embedder in use
has no semantic knowledge, and it is carried all the way to the API response
rather than logged and forgotten. A search that ranks well on shared words looks
identical to a search that understands the question, and the difference is the
entire owed migration - so the answer states which one produced it.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.corpus.documents import NAMESPACE_CONCEPTS
from app.corpus.embeddings import BaseEmbedder
from app.corpus.vector_store import VectorMatch, VectorStore

#: The RRF flattening constant. Named rather than written into the expression
#: because a test asserts behaviour in terms of it - per CLAUDE.md, a test pins
#: the constant and never its current value, so retuning this cannot break a test
#: about something else.
RRF_K = 60

#: How many candidates each half contributes before fusion. Wider than any
#: sensible page of results, because a chunk that both halves rank tenth should
#: still be able to beat one that only one half ranks first, and it cannot do
#: that if it was cut from a candidate list of five.
CANDIDATES_PER_HALF = 20

#: Embedders whose vectors carry no meaning beyond word overlap. Listed by model
#: id rather than detected, so adding a real provider means deleting nothing and
#: the flag cannot quietly become True for an embedder nobody assessed.
_NON_SEMANTIC_MODELS = frozenset({"fixture/hashed-v1"})


@dataclass(frozen=True, slots=True)
class ScoredChunk:
    """One retrieved chunk and where each half of the hybrid placed it.

    Both ranks are kept rather than only the fused score, because "the full-text
    half found this and the vector half did not" is the single most useful thing
    to know when a result looks wrong, and it is unrecoverable once the two are
    added together. None means that half did not return the chunk at all.
    """

    chunk_id: str
    document_id: str
    concept_slug: str | None
    title: str
    heading: str | None
    ord: int
    text: str
    score: float
    vector_rank: int | None
    text_rank: int | None
    #: Cosine similarity from the vector half, or None when that half did not
    #: return this chunk. Carried through fusion rather than discarded because
    #: it is the only score in this system that means the same thing across
    #: different queries - which is what makes a relevance floor possible
    #: (`app/ask/relevance.py`). The fused score cannot do that job.
    vector_similarity: float | None = None


@dataclass(frozen=True, slots=True)
class HybridResult:
    """The fused ranking, and an honest description of what produced it."""

    query: str
    chunks: tuple[ScoredChunk, ...]
    embedding_model: str
    #: False while the configured embedder ranks by word overlap alone. Carried
    #: into the API response; see the module docstring.
    vector_is_semantic: bool
    #: The strongest cosine similarity the vector half found for this query,
    #: across all candidates and not only the ones that survived fusion. None
    #: when that half returned nothing - an un-embedded corpus, which is an
    #: absence of evidence rather than evidence of irrelevance.
    best_similarity: float | None = None


@dataclass(frozen=True, slots=True)
class _Candidate:
    """A chunk seen by at least one half, before fusion."""

    chunk_id: str
    document_id: str
    concept_slug: str | None
    title: str
    heading: str | None
    ord: int
    text: str


def reciprocal_rank_fusion(
    rankings: list[list[str]], *, k: int = RRF_K
) -> dict[str, tuple[float, list[int | None]]]:
    """Fuse ordered id lists into a score per id, plus each list's rank for it.

    Pure, and separated from the SQL for that reason: this is the part of
    retrieval whose behaviour is worth pinning in a hermetic test, and it cannot
    be if it only exists inside a function that needs a database.

    Ranks are 1-based, which is what the formula assumes and what a reader
    expects to see reported. `None` in the returned rank list means that ranking
    did not contain the id at all - distinct from ranking it last.
    """
    scores: dict[str, float] = {}
    ranks: dict[str, list[int | None]] = {}

    for index, ranking in enumerate(rankings):
        for position, identifier in enumerate(ranking, start=1):
            if identifier not in ranks:
                ranks[identifier] = [None] * len(rankings)
                scores[identifier] = 0.0
            # A duplicate id within one ranking keeps its best position; the two
            # halves are independent, but nothing guarantees a half cannot
            # return the same chunk twice in future, and scoring it twice would
            # let one half outvote the other on its own.
            if ranks[identifier][index] is None:
                ranks[identifier][index] = position
                scores[identifier] += 1.0 / (k + position)

    return {identifier: (scores[identifier], ranks[identifier]) for identifier in scores}


def text_search(
    connection: Connection,
    *,
    query: str,
    limit: int,
    namespace: str = NAMESPACE_CONCEPTS,
    require_all_terms: bool = False,
) -> list[_Candidate]:
    """The full-text half: every query term, ORed, against the generated tsvector.

    `plainto_tsquery` rather than `to_tsquery` because the input is a user's
    sentence, not an expression: `to_tsquery` demands operators between terms and
    raises a syntax error on ordinary prose, which would turn a question with a
    stray `&` in it into a 500.

    **`require_all_terms` decides how strict this half is, and the right answer
    depends on the other half.** `plainto_tsquery` ANDs its terms, so "how do I
    bring my portfolio back to its target weights" becomes
    `bring & portfolio & back & target & weight` and requires one chunk to
    contain all five. Both settings were measured against the real corpus rather
    than reasoned about, and they disagree in opposite directions:

      * With a **placeholder** embedder, AND matched *nothing* for three of four
        natural-language questions. The lexical half was the only real one, and
        a real half that is silent is no half at all - so it has to be widened
        to OR or the hybrid is one fixture embedder wearing two hats.
      * With a **semantic** embedder, OR actively hurts. Over six paraphrased
        questions, the vector half alone put the right concept in its top three
        **5/6**, the ORed lexical half **2/6**, and fusing them **4/6** - the
        weak ranker dragging the strong one down, which is what equal-weight RRF
        does when the halves are not of comparable quality. AND scored **5/6**,
        because it stays silent unless it is confident and then complements
        rather than competes.

    So the caller passes what it knows: strict when the vector half can carry a
    paraphrase, wide when it cannot. This is a property the system already has,
    not a tuning constant - which is why it is a boolean rather than a weight.
    **The evidence is six hand-written questions and should be treated as a
    direction, not a measurement**; slice 4's eval set is what settles it.

    The widening is done by rendering `plainto_tsquery`'s output and replacing
    its operator rather than by building a tsquery from the raw string:
    `plainto_tsquery` has already done the parsing, stemming, stopword removal
    and quoting, so no user input is ever interpolated into an expression. The
    ranking still prefers the chunk that matched more of the question, because
    that is what `ts_rank_cd` measures - the operator changes which rows are
    candidates, not how they are ordered.

    `'english'` is pinned here and in the generated column in migration 0012. A
    mismatch between the two does not fail - it returns nothing, every time, for
    every query, which is why it is written in both places with this comment
    beside it.
    """
    rows = connection.execute(
        text(
            """
            WITH q AS (
                -- plainto_tsquery does the parsing and quoting; the widening
                -- only swaps its conjunction for a disjunction. The lexemes it
                -- emits are already quoted, so the replacement cannot reach
                -- anything the user typed.
                SELECT CASE WHEN :require_all_terms
                            THEN plainto_tsquery('english', :query)
                            ELSE replace(
                                plainto_tsquery('english', :query)::text, ' & ', ' | '
                            )::tsquery
                       END AS query
            )
            SELECT c.id           AS chunk_id,
                   d.id           AS document_id,
                   d.concept_slug AS concept_slug,
                   d.title        AS title,
                   c.heading      AS heading,
                   c.ord          AS ord,
                   c.text         AS text
              FROM kb_chunks c
              JOIN kb_documents d ON d.id = c.document_id
             CROSS JOIN q
             WHERE d.namespace = :namespace
               AND c.text_search @@ q.query
             ORDER BY ts_rank_cd(c.text_search, q.query) DESC,
                      -- A deterministic tie-break, so two chunks the ranker
                      -- scores identically do not swap places between calls.
                      -- An unstable order under a stable corpus is the kind of
                      -- thing that gets diagnosed as a caching bug.
                      c.id
             LIMIT :limit
            """
        ),
        {
            "namespace": namespace,
            "query": query,
            "limit": limit,
            "require_all_terms": require_all_terms,
        },
    ).all()

    return [
        _Candidate(
            chunk_id=str(row.chunk_id),
            document_id=str(row.document_id),
            concept_slug=row.concept_slug,
            title=row.title,
            heading=row.heading,
            ord=row.ord,
            text=row.text,
        )
        for row in rows
    ]


def _candidate_from_vector_match(match: VectorMatch) -> _Candidate:
    return _Candidate(
        chunk_id=match.chunk_id,
        document_id=match.document_id,
        concept_slug=match.concept_slug,
        title=match.title,
        heading=match.heading,
        ord=match.ord,
        text=match.text,
    )


async def hybrid_search(
    connection: Connection,
    store: VectorStore,
    embedder: BaseEmbedder,
    *,
    query: str,
    limit: int,
    namespace: str = NAMESPACE_CONCEPTS,
    candidates_per_half: int = CANDIDATES_PER_HALF,
) -> HybridResult:
    """Run both halves, fuse them by rank, and return the top `limit`.

    An empty query returns nothing rather than everything. Both halves would
    otherwise answer it - the full-text one with no rows, the vector one with an
    arbitrary nearest neighbour to a degenerate vector - and "here are some
    chunks" is not an answer to a question nobody asked.

    The vector half is asked only for rows embedded by *this* embedder. Comparing
    a query vector against rows some other model produced is the one way these
    tables return confident nonsense: same width, working operator, meaningless
    distances. So an un-embedded corpus degrades to the full-text half alone,
    visibly - every result carries a null `vector_rank` - rather than silently
    ranking against whatever is in the column.
    """
    if not query.strip():
        return HybridResult(
            query=query,
            chunks=(),
            embedding_model=embedder.model,
            best_similarity=None,
            vector_is_semantic=embedder.model not in _NON_SEMANTIC_MODELS,
        )

    is_semantic = embedder.model not in _NON_SEMANTIC_MODELS
    embedding = await embedder.embed_query(query)
    vector_matches = store.search(
        connection,
        embedding=embedding,
        limit=candidates_per_half,
        namespace=namespace,
        model=embedder.model,
    )
    # Strict when the vector half is semantic, wide when it is a placeholder.
    # See `text_search`: the two settings were measured and disagree in opposite
    # directions depending on what the other half can do.
    text_matches = text_search(
        connection,
        query=query,
        limit=candidates_per_half,
        namespace=namespace,
        require_all_terms=is_semantic,
    )

    by_id: dict[str, _Candidate] = {}
    similarities: dict[str, float] = {}
    for match in vector_matches:
        by_id.setdefault(match.chunk_id, _candidate_from_vector_match(match))
        similarities.setdefault(match.chunk_id, match.similarity)
    for candidate in text_matches:
        by_id.setdefault(candidate.chunk_id, candidate)

    fused = reciprocal_rank_fusion(
        [
            [match.chunk_id for match in vector_matches],
            [candidate.chunk_id for candidate in text_matches],
        ]
    )

    ordered = sorted(
        fused.items(),
        # Score descending, then chunk id, for the same determinism the
        # full-text ORDER BY buys: two chunks each half ranks symmetrically have
        # identical RRF scores, and that is a common case with two halves, not a
        # rare one.
        key=lambda item: (-item[1][0], item[0]),
    )[:limit]

    chunks = tuple(
        ScoredChunk(
            chunk_id=chunk_id,
            document_id=by_id[chunk_id].document_id,
            concept_slug=by_id[chunk_id].concept_slug,
            title=by_id[chunk_id].title,
            heading=by_id[chunk_id].heading,
            ord=by_id[chunk_id].ord,
            text=by_id[chunk_id].text,
            score=score,
            vector_rank=ranks[0],
            text_rank=ranks[1],
            vector_similarity=similarities.get(chunk_id),
        )
        for chunk_id, (score, ranks) in ordered
    )

    return HybridResult(
        query=query,
        chunks=chunks,
        embedding_model=embedder.model,
        # Over every candidate, not only the survivors: a strong match pushed
        # out of the top `limit` by fusion is still evidence that the corpus
        # covers the question, and the floor is asking exactly that.
        best_similarity=max(similarities.values(), default=None),
        vector_is_semantic=is_semantic,
    )
