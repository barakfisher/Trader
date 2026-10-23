"""The provider keys for the Admin page's Keys tab (D251, D288): status, never values.

Internal key only: the orchestrator's admin gate decides who may ask, and audits a test.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.engine import Engine

from app.config import get_settings
from app.db import get_engine
from app.deps import require_internal_key
from app.installation_keys import KEY_NAMES, check_key, key_statuses
from app.models import (
    InstallationKeyLastError,
    InstallationKeysResponse,
    InstallationKeyStatus,
    InstallationKeyTestResponse,
)

router = APIRouter(
    prefix="/installation/keys",
    tags=["installation"],
    dependencies=[Depends(require_internal_key)],
)


@router.get("", response_model=InstallationKeysResponse)
async def installation_keys(engine: Engine = Depends(get_engine)) -> InstallationKeysResponse:
    return InstallationKeysResponse(
        keys=[
            InstallationKeyStatus(
                name=key.name,
                provider=key.provider,
                is_set=key.is_set,
                serves=list(key.serves),
                unused=key.unused,
                testable=key.testable,
                last_error=(
                    InstallationKeyLastError(at=key.last_error.at, message=key.last_error.message)
                    if key.last_error is not None
                    else None
                ),
            )
            for key in key_statuses(get_settings(), engine)
        ]
    )


@router.post("/{name}/test", response_model=InstallationKeyTestResponse)
async def installation_key_test(name: str) -> InstallationKeyTestResponse:
    if name not in KEY_NAMES:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, {"code": "no_such_key", "message": "no such key"}
        )
    result = await check_key(name, get_settings())
    if result is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {"code": "key_not_testable", "message": "this key is not set or has no free check"},
        )
    return InstallationKeyTestResponse(
        ok=result.ok, detail=result.detail, checked_at=result.checked_at
    )
