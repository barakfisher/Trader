"""Database engine for the AI service.

The AI service owns the schema (Alembic migrations live here); the orchestrator
reads and writes the same tables through its own typed queries. Milestone 1 uses
this only for migrations and the seed, so the engine is created lazily.
"""

from __future__ import annotations

from functools import lru_cache

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

from app.config import get_settings


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    settings = get_settings()
    # psycopg 3 driver; pool_pre_ping survives Postgres restarts in local dev.
    url = settings.database_url.replace("postgresql://", "postgresql+psycopg://", 1)
    return create_engine(url, pool_pre_ping=True, future=True)
