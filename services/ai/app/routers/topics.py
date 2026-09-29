"""`POST /topics/resolve` (FR-10, M5): a theme in, candidate instruments out.
`POST /topics/discover` (FR-11): recurring phrases in collected headlines.

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

from dataclasses import replace
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy.engine import Engine

from app.corpus.embeddings import BaseEmbedder
from app.corpus.retrieval import _NON_SEMANTIC_MODELS
from app.db import get_engine
from app.deps import SettingsDep, get_embedder, require_internal_key
from app.models import (
    DiscoveredHeadline,
    DiscoveredPhrase,
    TopicCandidateOut,
    TopicDiscoverRequest,
    TopicDiscoverResponse,
    TopicHolder,
    TopicInterpretationOut,
    TopicResolveRequest,
    TopicResolveResponse,
    UniverseCoverageOut,
)
from app.news.entities import InstrumentRef, name_aliases
from app.news.outlet_countries import load_outlet_countries
from app.news.queries import load_window_headlines
from app.topics.discovery import MIN_SOURCES, MIN_STORIES, recurring_phrases
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


@router.post("/topics/discover", response_model=TopicDiscoverResponse)
async def discover(
    payload: TopicDiscoverRequest,
    settings: SettingsDep,
    engine: Engine = Depends(get_engine),
) -> TopicDiscoverResponse:
    """Recurring phrases in the last `days` of headlines. Reads; stores nothing.

    No embedding happens here. The orchestrator filters the phrases against the
    user's topics and rejection memory first, and resolves only what survives -
    so a theme the user rejected costs nothing on the day it recurs.
    """
    since = datetime.now(UTC) - timedelta(days=payload.days)
    names: list[str] = []
    for item in payload.instruments:
        ref = InstrumentRef(
            symbol=item.symbol.upper(),
            name=item.name,
            asset_class=item.asset_class,
            instrument_id=item.instrument_id,
        )
        # Tickers of two letters are ordinary words too often ("AI" is C3.ai);
        # cutting those out of every headline would cost real themes.
        if len(ref.symbol) >= 3:
            names.append(ref.symbol)
        names.extend(name_aliases(ref))
    with engine.connect() as connection:
        headlines = load_window_headlines(connection, since=since)
    # Each headline carries its outlet's home country, so a phrase can report
    # whose press carried it (decision 61). Read once per process.
    countries = load_outlet_countries(settings.outlets_dir)
    headlines = [
        replace(h, country=country.code if (country := countries.country(h.source)) else None)
        for h in headlines
    ]
    phrases = recurring_phrases(headlines, exclude_names=names)[: payload.limit]
    return TopicDiscoverResponse(
        since=since,
        days=payload.days,
        headlines=len(headlines),
        min_stories=MIN_STORIES,
        min_sources=MIN_SOURCES,
        phrases=[
            DiscoveredPhrase(
                phrase=p.text,
                words=list(p.key),
                story_count=p.story_count,
                article_count=p.article_count,
                source_count=p.source_count,
                lead_instrument=p.lead_instrument[0],
                lead_instrument_articles=p.lead_instrument[1],
                lead_country=p.lead_country[0],
                lead_country_name=countries.name(p.lead_country[0]) if p.lead_country[0] else None,
                lead_country_articles=p.lead_country[1],
                headlines=[
                    DiscoveredHeadline(
                        article_id=h.article_id,
                        title=h.title,
                        source=h.source,
                        published_at=h.published_at,
                    )
                    for h in p.headlines
                ],
            )
            for p in phrases
        ],
    )
