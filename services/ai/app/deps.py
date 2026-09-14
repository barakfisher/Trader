"""FastAPI dependencies: shared singletons and service-to-service auth."""

from __future__ import annotations

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

    In development the check is skipped when the key is left at its default so a
    fresh clone works without ceremony; in production a mismatch is a hard 401.
    """
    if not settings.is_production and settings.internal_api_key == "change-me-internal":
        return
    if x_internal_key != settings.internal_api_key:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid internal API key")


MarketDataDep = Annotated[MarketDataService, Depends(get_market_data)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
