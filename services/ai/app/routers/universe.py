"""The universe's two background jobs: an on-demand profile, and the rescreen (M8).

**On demand** (decision 89): describe a listing the universe lacks.

The orchestrator calls this when a user names a US equity or ETF that is not
a member - a real gap. The answer comes at once (202); the fetch and the
embedding run after it, so no import, holding or topic ever waits on Yahoo.

`BackgroundTasks` runs in this process after the response is sent. A copy of
the service that dies mid-fetch loses that fetch, and the next time a user
names the symbol it is asked for again: the fetch is idempotent
(`insert_on_demand` never overwrites), so a retry is the recovery.

**The rescreen** (decision 90): carry out a `universe_rescreen` run the
orchestrator claimed. Answered at once; the run row is finished by
`app/universe/rescreen.py`, which heartbeats while it works so that only a dead
process's run is ever reclaimed.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, status
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.config import Settings
from app.corpus.embeddings import BaseEmbedder
from app.db import get_engine
from app.deps import SettingsDep, get_embedder, get_profile_source, require_internal_key
from app.models import (
    ProfileRequest,
    ProfileRequestResponse,
    RescreenRequest,
    RescreenResponse,
)
from app.universe.on_demand import profile_on_demand
from app.universe.profile_source import InstrumentProfileSource
from app.universe.profiles import profile_exists
from app.universe.rescreen import run_rescreen

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


#: Rescreen runs this copy of the service is carrying out now.
_rescreens: set[str] = set()


def _rescreen_unavailable(settings: Settings, source: InstrumentProfileSource | None) -> str | None:
    if not settings.universe_snapshot_dir:
        return "UNIVERSE_SNAPSHOT_DIR is not set: there is nowhere to write a new snapshot"
    if source is None:
        return "the market-data chain does not use Yahoo, which the screen is built from"
    return None


async def _rescreen(run_id: str, volume: Path, engine: Engine, embedder: BaseEmbedder) -> None:
    try:
        await run_rescreen(run_id, volume=volume, engine=engine, embedder=embedder)
    finally:
        _rescreens.discard(run_id)


@router.post(
    "/rescreen",
    response_model=RescreenResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def rescreen(
    payload: RescreenRequest,
    background: BackgroundTasks,
    settings: SettingsDep,
    engine: Engine = Depends(get_engine),
    embedder: BaseEmbedder = Depends(get_embedder),
    source: InstrumentProfileSource | None = Depends(get_profile_source),
) -> RescreenResponse:
    run_id = payload.run_id
    reason = _rescreen_unavailable(settings, source)
    if reason is not None:
        return RescreenResponse(run_id=run_id, status="unavailable", reason=reason)
    if run_id in _rescreens:
        return RescreenResponse(run_id=run_id, status="in_progress")
    with engine.connect() as connection:
        running = connection.execute(
            text(
                "SELECT EXISTS (SELECT 1 FROM runs WHERE id = CAST(:id AS uuid) "
                "AND kind = 'universe_rescreen' AND status = 'running')"
            ),
            {"id": run_id},
        ).scalar_one()
    if not running:
        return RescreenResponse(run_id=run_id, status="not_running")
    _rescreens.add(run_id)
    volume = Path(str(settings.universe_snapshot_dir))
    background.add_task(_rescreen, run_id, volume, engine, embedder)
    return RescreenResponse(run_id=run_id, status="started")
