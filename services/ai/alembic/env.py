"""Alembic environment. The database URL always comes from app config, never
from alembic.ini, so there is exactly one source of truth for connection details.
"""

from __future__ import annotations

from sqlalchemy import pool

from alembic import context
from app.db import get_engine

config = context.config


def run_migrations_offline() -> None:
    context.configure(
        url=str(get_engine().url), literal_binds=True, dialect_opts={"paramstyle": "named"}
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = get_engine().execution_options(poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
