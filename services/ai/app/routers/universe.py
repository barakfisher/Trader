"""Describe a listing the universe lacks, on demand (M8, decision 89).

The orchestrator calls this when a user names a US equity or ETF that is not
a member - a real gap. The answer comes at once (202); the fetch and the
embedding run after it, so no import, holding or topic ever waits on Yahoo.

`BackgroundTasks` runs in this process after the response is sent. A copy of
the service that dies mid-fetch loses that fetch, and the next time a user
names the symbol it is asked for again: the fetch is idempotent
(`insert_on_demand` never overwrites), so a retry is the recovery.
"""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, status
from sqlalchemy.engine import Engine

from app.corpus.embeddings import BaseEmbedder
from app.db import get_engine
from app.deps import get_embedder, get_profile_source, require_internal_key
from app.models import ProfileRequest, ProfileRequestResponse
from app.universe.on_demand import profile_on_demand
from app.universe.profile_source import InstrumentProfileSource
from app.universe.profiles import profile_exists

router = APIRouter(
    prefix="/universe", tags=["universe"], dependencies=[Depends(require_internal_key)]
)

#: Symbols this copy of the service is fetching now. A user who imports a file
#: naming the same small company on ten rows asks ten times; one fetch answers.
_in_flight: set[str] = set()


async def _fetch(
    symbol: str, source: InstrumentProfileSource, engine: Engine, embedder: BaseEmbedder
) -> None:
    try:
        await profile_on_demand(symbol, source=source, engine=engine, embedder=embedder)
    finally:
        _in_flight.discard(symbol)


@router.post(
    "/profiles",
    response_model=ProfileRequestResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def request_profile(
    payload: ProfileRequest,
    background: BackgroundTasks,
    engine: Engine = Depends(get_engine),
    embedder: BaseEmbedder = Depends(get_embedder),
    source: InstrumentProfileSource | None = Depends(get_profile_source),
) -> ProfileRequestResponse:
    symbol = payload.symbol.upper()
    if source is None:
        return ProfileRequestResponse(symbol=symbol, status="unavailable")
    if symbol in _in_flight:
        return ProfileRequestResponse(symbol=symbol, status="in_progress")
    with engine.connect() as connection:
        if profile_exists(connection, symbol):
            return ProfileRequestResponse(symbol=symbol, status="already_profiled")
    _in_flight.add(symbol)
    background.add_task(_fetch, symbol, source, engine, embedder)
    return ProfileRequestResponse(symbol=symbol, status="queued")
