"""Runs and observations (Milestone 2 foundation).

Two tables the analysis engine is built on.

`runs` makes scheduled work idempotent in a way that survives a restart. Until
now the set of already-executed run keys lived in a JavaScript Map inside the
orchestrator process, so every restart forgot the day's history and the timer
re-ran work within ten seconds of boot. That was tolerable only because
`portfolio_snapshots` has a unique constraint that made the duplicate harmless.
It stops being tolerable in Milestone 4, where the same mechanism gates Telegram
alerts: a message, once sent, cannot be deduplicated retroactively.

`observations` is what the analysis engine produces. Every row carries the
evidence behind it, because the product's central rule is that a claim without
its data is not shippable.

Revision ID: 0003_runs_and_observations
Revises: 0002_snapshot_integrity
"""

from alembic import op

revision = "0003_runs_and_observations"
down_revision = "0002_snapshot_integrity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE runs (
            id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
            kind        text NOT NULL
                        CHECK (kind IN ('snapshot','portfolio_scan','topic_scan','daily_digest')),
            -- The idempotency key. Claiming a run is an INSERT: if the key is
            -- taken, the work has already been done or is being done, and the
            -- caller stops. The database arbitrates, so this survives restarts
            -- and works across replicas - neither of which the in-process map did.
            run_key     text NOT NULL UNIQUE,
            trigger     text NOT NULL DEFAULT 'unknown',
            status      text NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running','ok','degraded','failed','skipped')),
            started_at  timestamptz NOT NULL DEFAULT now(),
            finished_at timestamptz,
            -- What the run did: counts, costs, which providers answered. Read by
            -- the freshness check that asks "did anything actually run today?",
            -- which is the only monitoring that catches a silently broken cron.
            stats       jsonb NOT NULL DEFAULT '{}'::jsonb
        )
        """
    )
    op.execute("CREATE INDEX runs_recent_idx ON runs (user_id, kind, started_at DESC)")

    op.execute(
        """
        CREATE TABLE observations (
            id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            -- Kept when a run is deleted: an observation outlives the run that
            -- produced it, and losing the finding to tidy up bookkeeping would
            -- be the wrong trade.
            run_id       uuid REFERENCES runs(id) ON DELETE SET NULL,
            kind         text NOT NULL,
            severity     text NOT NULL DEFAULT 'info'
                         CHECK (severity IN ('info','notable','high')),
            -- What the observation is about: an instrument, the portfolio as a
            -- whole, or a topic. `subject_ref` is the symbol or topic label.
            subject_kind text NOT NULL DEFAULT 'instrument'
                         CHECK (subject_kind IN ('instrument','portfolio','topic')),
            subject_ref  text,
            headline     text NOT NULL,
            explanation  text,
            -- The data the claim rests on: prices, dates, thresholds, article
            -- URLs. Every figure in `headline` and `explanation` must be present
            -- here; the narration validator rejects any that is not.
            evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
            -- Financial concepts invoked, so any term is one click from an
            -- explanation once the RAG corpus exists.
            concept_refs text[] NOT NULL DEFAULT '{}',
            -- hash(kind, subject, time bucket, severity). Re-running a scan over
            -- unchanged data must not produce a second copy of the same finding,
            -- and must not notify twice.
            dedupe_key   text NOT NULL UNIQUE,
            created_at   timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX observations_feed_idx ON observations (user_id, created_at DESC)")
    op.execute("CREATE INDEX observations_run_idx ON observations (run_id)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS observations")
    op.execute("DROP TABLE IF EXISTS runs")
