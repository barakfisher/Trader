"""FastAPI dependencies: shared singletons and service-to-service auth."""

from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status

from app.config import Settings, get_settings
from app.providers.registry import MarketDataService


def get_market_data(request: Request) -> MarketDataService:
    service = getattr(request.app.state, "market_data", None)
    if service is None:  # pragma: no cover - only reachable if startup failed
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "market data service not initialised"
        )
    return service


async def require_internal_key(
    x_internal_key: Annotated[str | None, Header(alias="x-internal-key")] = None,
    settings: Settings = Depends(get_settings),
) -> None:
    """The AI service is never exposed publicly; the orchestrator is its only client.

    This check has no development bypass. An earlier version skipped it when the
    key was still at its default value, which meant the protection silently did
    not run whenever APP_ENV was unset - a security control that is absent
    exactly when someone has forgotten to configure it. A fresh clone still
    works without ceremony, because both services read the same key from the
    same .env: whatever the value is, they agree on it.

    compare_digest keeps the comparison constant-time, so response timing cannot
    be used to recover the key one character at a time.
    """
    if x_internal_key is None or not secrets.compare_digest(
        x_internal_key, settings.internal_api_key
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid internal API key")


MarketDataDep = Annotated[MarketDataService, Depends(get_market_data)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
