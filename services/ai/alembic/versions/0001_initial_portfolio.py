"""Initial portfolio schema (Milestone 1).

Conventions established here and expected by every later migration:
  * Every user-owned row carries `user_id`, even though v1 ships one account.
  * Money is `bigint` minor units plus an explicit `currency` column. Never float.
  * Quantities are `numeric(38, 18)` so fractional crypto is exact.
  * Timestamps are `timestamptz`, always stored in UTC.

Revision ID: 0001_initial_portfolio
Revises: None
"""

from alembic import op

revision = "0001_initial_portfolio"
down_revision = None
branch_labels = None
depends_on = None

SEED_USER_ID = "00000000-0000-0000-0000-000000000001"


def upgrade() -> None:
    # pgvector is enabled now so the RAG milestone needs no privileged step later.
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.execute(
        """
        CREATE TABLE users (
            id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            email         text UNIQUE,
            base_currency text        NOT NULL DEFAULT 'USD',
            timezone      text        NOT NULL DEFAULT 'Asia/Jerusalem',
            quiet_hours   jsonb       NOT NULL DEFAULT '{"start": "22:00", "end": "07:00"}'::jsonb,
            created_at    timestamptz NOT NULL DEFAULT now()
        )
        """
    )

    op.execute(
        """
        CREATE TABLE instruments (
            id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            symbol       text NOT NULL,
            asset_class  text NOT NULL DEFAULT 'unknown'
                         CHECK (asset_class IN ('equity','etf','crypto','fx','index','unknown')),
            exchange     text,
            currency     text NOT NULL DEFAULT 'USD',
            name         text,
            provider_ids jsonb       NOT NULL DEFAULT '{}'::jsonb,
            created_at   timestamptz NOT NULL DEFAULT now(),
            UNIQUE (symbol)
        )
        """
    )

    op.execute(
        """
        CREATE TABLE holdings (
            id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            instrument_id    uuid NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
            quantity         numeric(38, 18) NOT NULL CHECK (quantity > 0),
            -- Cost basis is the PER-UNIT purchase price in `currency`, in minor
            -- units. Total cost = quantity * cost_basis_minor, computed at read
            -- time so quantity edits cannot desynchronise it.
            cost_basis_minor bigint,
            currency         text NOT NULL DEFAULT 'USD',
            opened_at        date,
            notes            text,
            created_at       timestamptz NOT NULL DEFAULT now(),
            updated_at       timestamptz NOT NULL DEFAULT now(),
            -- One row per instrument per user: imports merge into it rather than
            -- accumulating duplicates (see FLOWS.md F1).
            UNIQUE (user_id, instrument_id)
        )
        """
    )
    op.execute("CREATE INDEX holdings_user_idx ON holdings (user_id)")

    op.execute(
        """
        CREATE TABLE target_weights (
            user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            instrument_id uuid NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
            weight        numeric(6, 4) NOT NULL CHECK (weight >= 0 AND weight <= 1),
            PRIMARY KEY (user_id, instrument_id)
        )
        """
    )

    op.execute(
        """
        CREATE TABLE quotes (
            instrument_id uuid NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
            as_of         timestamptz NOT NULL,
            price_minor   bigint NOT NULL,
            currency      text   NOT NULL,
            source        text   NOT NULL,
            delay_seconds integer NOT NULL DEFAULT 0,
            PRIMARY KEY (instrument_id, as_of)
        )
        """
    )
    op.execute("CREATE INDEX quotes_recent_idx ON quotes (instrument_id, as_of DESC)")

    op.execute(
        """
        CREATE TABLE portfolio_snapshots (
            id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            as_of       date NOT NULL,
            total_minor bigint NOT NULL,
            cost_minor  bigint NOT NULL DEFAULT 0,
            currency    text   NOT NULL,
            breakdown   jsonb  NOT NULL DEFAULT '[]'::jsonb,
            created_at  timestamptz NOT NULL DEFAULT now(),
            -- One snapshot per day per user; a re-run overwrites it.
            UNIQUE (user_id, as_of)
        )
        """
    )

    # Single-user v1: seed the one account so login has something to attach to.
    op.execute(
        f"""
        INSERT INTO users (id, email, base_currency, timezone)
        VALUES ('{SEED_USER_ID}', NULL, 'USD', 'Asia/Jerusalem')
        ON CONFLICT (id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS portfolio_snapshots")
    op.execute("DROP TABLE IF EXISTS quotes")
    op.execute("DROP TABLE IF EXISTS target_weights")
    op.execute("DROP TABLE IF EXISTS holdings")
    op.execute("DROP TABLE IF EXISTS instruments")
    op.execute("DROP TABLE IF EXISTS users")
