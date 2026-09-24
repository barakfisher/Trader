"""`POST /topics/resolve` (FR-10, M5): a theme in, candidate instruments out.

Thin, like every router here: the resolver is `app/topics/resolution.py` and
its reasoning is in `docs/TOPIC_RESOLUTION.md`. This checks that there is a
universe to resolve against, runs the resolver, and converts its shapes to the
wire's.

**An unloaded universe is a named state, not an error.** The descriptions the
resolver matches on are not committed (Yahoo's licence; decision 40), so a
fresh clone, a CI run and a database nobody loaded all have no searchable
universe - and that is a condition of the installation, not a fault in the
request. It is answered as a 200 with `verdict: unavailable` and a
`universe.state` naming the missing step, following `/concepts/:slug`'s
precedent that an un-ingested corpus is a real state. What it must never do is
reach the resolver: `search_profiles` over an empty table returns nothing,
`judge(None)` says `none`, and the user would be told that their topic matches
nothing when the truth is that nothing was looked at.

Nothing here subscribes, stores or confirms. Resolution proposes; the user
decides, and that decision is recorded by the orchestrator, not here.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.engine import Engine

from app.corpus.embeddings import BaseEmbedder
from app.corpus.retrieval import _NON_SEMANTIC_MODELS
from app.db import get_engine
from app.deps import get_embedder, require_internal_key
from app.models import (
    TopicCandidateOut,
    TopicHolder,
    TopicInterpretationOut,
    TopicResolveRequest,
    TopicResolveResponse,
    UniverseCoverageOut,
)
from app.topics.resolution import NOTHING_BELOW, STRONG_ABOVE, TopicResolution, resolve_topic
from app.universe.profiles import UniverseCoverage, coverage

router = APIRouter(tags=["topics"], dependencies=[Depends(require_internal_key)])


def _universe(covered: UniverseCoverage) -> UniverseCoverageOut:
    return UniverseCoverageOut(
        state=covered.state.value, profiles=covered.profiles, embedded=covered.embedded
    )


def _response(resolution: TopicResolution, covered: UniverseCoverage) -> TopicResolveResponse:
    judgement = resolution.judgement
    return TopicResolveResponse(
        topic=resolution.topic,
        verdict=judgement.relevance.value,
        best_similarity=judgement.best_similarity,
        refuse_below=judgement.refuse_below,
        confident_above=judgement.confident_above,
        interpretations=[
            TopicInterpretationOut(
                label=interpretation.label,
                candidates=[
                    TopicCandidateOut(
                        instrument_id=c.instrument_id,
                        symbol=c.symbol,
                        name=c.name,
                        asset_class=c.asset_class,
                        sector=c.sector,
                        industry=c.industry,
                        similarity=c.similarity,
                        size_minor=c.size_minor,
                        size_currency=c.size_currency,
                        confidence=c.confidence.value,
                        rationale=c.rationale,
                        held_by=[TopicHolder(etf=h.etf, weight=h.weight) for h in c.held_by],
                    )
                    for c in interpretation.candidates
                ],
            )
            for interpretation in resolution.interpretations
        ],
        ambiguous=resolution.ambiguous,
        universe=_universe(covered),
        embedding_model=resolution.embedding_model,
        vector_is_semantic=resolution.vector_is_semantic,
    )


@router.post("/topics/resolve", response_model=TopicResolveResponse)
async def resolve(
    payload: TopicResolveRequest,
    engine: Engine = Depends(get_engine),
    embedder: BaseEmbedder = Depends(get_embedder),
) -> TopicResolveResponse:
    topic = payload.topic.strip()
    with engine.connect() as connection:
        covered = coverage(connection, model=embedder.model)
        if not covered.searchable:
            # Checked before the topic is embedded, so an installation with no
            # universe also spends nothing on the embedding provider.
            return TopicResolveResponse(
                topic=topic,
                verdict="unavailable",
                best_similarity=None,
                refuse_below=NOTHING_BELOW,
                confident_above=STRONG_ABOVE,
                ambiguous=False,
                universe=_universe(covered),
                embedding_model=embedder.model,
                vector_is_semantic=embedder.model not in _NON_SEMANTIC_MODELS,
            )
        resolution = await resolve_topic(connection, embedder, topic)
    return _response(resolution, covered)
