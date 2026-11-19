"""The daily upcoming-IPO run's endpoint (migration 0089), under the internal key.

Answered when done, like the new-listings screen: two searches and at most
`MAX_COMPANIES_PER_RUN` company histories at SEC's pace, about half a minute
on a first run and a few seconds after it. The orchestrator's run waits for it
and records the answer. A search that failed is a 502 and the run is retried;
it never reads as "nothing new".
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.engine import Engine

from app.db import get_engine
from app.deps import get_filings_provider, require_internal_key
from app.filings.base import FilingsProvider, FilingsProviderError
from app.filings.upcoming import track_upcoming_listings
from app.models import UpcomingIposResponse

router = APIRouter(
    prefix="/filings", tags=["filings"], dependencies=[Depends(require_internal_key)]
)


@router.post("/upcoming-ipos", response_model=UpcomingIposResponse)
async def upcoming_ipos(
    engine: Engine = Depends(get_engine),
    provider: FilingsProvider | None = Depends(get_filings_provider),
) -> UpcomingIposResponse:
    if provider is None:
        return UpcomingIposResponse(status="unavailable", reason="FILINGS_PROVIDER is off")
    try:
        report = await track_upcoming_listings(
            engine=engine, provider=provider, today=datetime.now(UTC).date()
        )
    except FilingsProviderError as error:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"the filings could not be searched: {error}"
        ) from error
    return UpcomingIposResponse(
        status="done",
        searched=report.searched,
        tracked=report.tracked,
        excluded=dict(report.excluded),
        advanced=report.advanced,
        listed=report.listed,
        failed=report.failed,
        deferred=report.deferred,
    )
