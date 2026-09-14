"""AI & analytics microservice entrypoint.

Milestone 1 surface: market data (quotes, instrument resolution, FX) behind the
provider chain. The analysis pipeline (M2) and RAG engine (M3) mount onto this
same app as additional routers.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from app.config import get_settings
from app.core.cache import Cache
from app.core.logging import configure_logging, get_logger, request_id_var
from app.core.ratelimit import RateLimiter
from app.providers.registry import MarketDataService, build_providers
from app.routers import health, market

settings = get_settings()
configure_logging(settings.log_level, json_output=settings.is_production)
log = get_logger("main")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    log.info("startup", env=settings.app_env, providers=settings.market_data_chain)
    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    app.state.redis = redis
    cache = Cache(redis)
    limiter = RateLimiter(redis)
    app.state.market_data = MarketDataService(build_providers(settings), cache, limiter, settings)
    try:
        yield
    finally:
        await redis.aclose()
        log.info("shutdown")


app = FastAPI(
    title="Traders AI Service",
    version=health.VERSION,
    description="Market data, analysis pipeline and RAG engine for the portfolio copilot.",
    lifespan=lifespan,
)

# The AI service is not browser-facing; CORS exists only for local API exploration.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_context(request: Request, call_next):
    """Adopt the orchestrator's request id so one user action has one id end to end."""
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    token = request_id_var.set(request_id)
    try:
        response = await call_next(request)
    finally:
        request_id_var.reset(token)
    response.headers["x-request-id"] = request_id
    return response


app.include_router(health.router)
app.include_router(market.router)
