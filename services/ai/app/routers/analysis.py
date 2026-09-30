"""The analysis endpoint the scheduled scan calls.

Stateless by design: the orchestrator owns the portfolio, the valuation and the
decision to run, and it persists whatever comes back. This service owns the
history, the rules and the words. Keeping the write on the orchestrator's side
means one process is responsible for idempotency, and it is the one holding the
run key.
"""

from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, Request

from app.analysis.pipeline import (
    ScanObservation,
    ScanSubject,
    TopicInstrument,
    TopicSubject,
    run_portfolio_scan,
    run_topic_scan,
)
from app.analysis.thresholds import AnalysisThresholds
from app.core.logging import get_logger
from app.db import get_engine
from app.deps import SettingsDep, require_internal_key
from app.models import (
    ObservationOut,
    PortfolioScanRequest,
    PortfolioScanResponse,
    ScanStatsOut,
    TopicScanRequest,
    TopicScanResponse,
    TopicScanStatsOut,
)
from app.providers.price_provenance import excluded_price_sources

router = APIRouter(
    prefix="/analysis",
    tags=["analysis"],
    dependencies=[Depends(require_internal_key)],
)
log = get_logger("analysis.router")


@router.post("/portfolio-scan", response_model=PortfolioScanResponse)
async def portfolio_scan(
    payload: PortfolioScanRequest,
    request: Request,
    settings: SettingsDep,
) -> PortfolioScanResponse:
    subjects = [
        ScanSubject(
            instrument_id=holding.instrument_id,
            symbol=holding.symbol.upper(),
            value_minor=holding.value_minor,
            currency=holding.currency.upper(),
            as_of=holding.as_of,
        )
        for holding in payload.holdings
    ]
    targets = {symbol.upper(): Decimal(weight) for symbol, weight in payload.target_weights.items()}

    # The LLM is built per request rather than held on app state: narration is
    # optional, and a provider that failed to build at startup must not be the
    # reason a scan cannot run at all.
    llm = getattr(request.app.state, "llm", None)

    with get_engine().begin() as connection:
        observations, stats = await run_portfolio_scan(
            connection,
            subjects,
            targets,
            base_currency=payload.base_currency.upper(),
            thresholds=AnalysisThresholds.from_settings(settings),
            llm=llm,
            known_dedupe_keys=payload.known_dedupe_keys,
            excluded_sources=excluded_price_sources(settings.market_data_chain),
            user_id=str(payload.user_id) if payload.user_id else None,
        )

    return PortfolioScanResponse(
        observations=[_observation_out(item) for item in observations],
        stats=ScanStatsOut(**vars(stats)),
    )


@router.post("/topic-scan", response_model=TopicScanResponse)
async def topic_scan(
    payload: TopicScanRequest,
    request: Request,
    settings: SettingsDep,
) -> TopicScanResponse:
    """Measure each confirmed topic as an equal-weighted basket (FLOWS F5).

    Price movement only, for now: news per topic needs a news run that does not
    exist yet, and this endpoint says nothing about news rather than implying it
    looked.
    """
    topics = [
        TopicSubject(
            topic_id=topic.topic_id,
            label=topic.label,
            instruments=[
                TopicInstrument(instrument_id=item.instrument_id, symbol=item.symbol.upper())
                for item in topic.instruments
            ],
        )
        for topic in payload.topics
    ]
    llm = getattr(request.app.state, "llm", None)

    with get_engine().begin() as connection:
        observations, stats = await run_topic_scan(
            connection,
            topics,
            thresholds=AnalysisThresholds.from_settings(settings),
            llm=llm,
            known_dedupe_keys=payload.known_dedupe_keys,
            excluded_sources=excluded_price_sources(settings.market_data_chain),
            user_id=str(payload.user_id) if payload.user_id else None,
        )

    return TopicScanResponse(
        observations=[_observation_out(item) for item in observations],
        stats=TopicScanStatsOut(**vars(stats)),
    )


def _observation_out(item: ScanObservation) -> ObservationOut:
    return ObservationOut(
        kind=item.finding.kind,
        severity=item.finding.severity,
        subject_ref=item.finding.subject_ref,
        as_of=item.finding.as_of,
        headline=item.narration.headline,
        explanation=item.narration.explanation,
        evidence=item.narration.evidence,
        concept_refs=list(item.narration.concepts),
        dedupe_key=item.dedupe_key,
        narration_source=item.narration.source,
        fallback_reason=item.narration.fallback_reason,
    )
