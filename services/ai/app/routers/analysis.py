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

from app.analysis.pipeline import ScanSubject, run_portfolio_scan
from app.analysis.thresholds import AnalysisThresholds
from app.core.logging import get_logger
from app.db import get_engine
from app.deps import SettingsDep, require_internal_key
from app.models import ObservationOut, PortfolioScanRequest, PortfolioScanResponse, ScanStatsOut

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
        )

    return PortfolioScanResponse(
        observations=[
            ObservationOut(
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
            for item in observations
        ],
        stats=ScanStatsOut(**vars(stats)),
    )
