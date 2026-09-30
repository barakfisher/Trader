"""Liveness and readiness probes.

`/healthz` answers as long as the process is up. `/readyz` actually touches Redis
and reports the provider chain, because "ready" means "can serve a quote".

A degraded `/readyz` answers 503, not 200 with "degraded" in the body: a
Kubernetes readiness probe reads only the status code, so a 200 would keep a
pod that cannot reach Redis - every quote, cache and budget call fails without
it - in rotation. Redis is this service's own store; no other service is
consulted, so one service's outage cannot take this one out of rotation.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response

from app.models import HealthResponse

router = APIRouter(tags=["health"])

VERSION = "0.1.0"


@router.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    return HealthResponse(status="ok", version=VERSION)


@router.get("/readyz", response_model=HealthResponse)
async def readyz(request: Request, response: Response) -> HealthResponse:
    checks: dict[str, str] = {}

    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        checks["redis"] = "not initialised"
    else:
        try:
            await redis.ping()
            checks["redis"] = "ok"
        except Exception as exc:  # noqa: BLE001
            checks["redis"] = f"error: {exc}"

    service = getattr(request.app.state, "market_data", None)
    checks["providers"] = ",".join(service.chain) if service else "not initialised"

    degraded = any(
        value.startswith("error") or value == "not initialised" for value in checks.values()
    )
    if degraded:
        response.status_code = 503
    return HealthResponse(status="degraded" if degraded else "ok", version=VERSION, checks=checks)
