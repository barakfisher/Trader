"""Durable state for the Mastra proposal-lifecycle workflow (M4).

One schema and one table, and both exist because of the same constraint: a
proposal can suspend a workflow for a day, and a workflow that cannot survive a
process restart cannot wait a day for anybody.

**Why a separate `mastra` schema.** The table below is not ours - its shape is
Mastra's, it is read and written by library code we did not author, and it will
change when the library does. Everything in `public` is a domain table whose
columns this project argues about; mixing a vendor's runtime state in with them
makes `\\dt` a worse answer to "what is this product's data model?" every time
the vendor adds a feature. The namespace also makes the blast radius of a
version upgrade literal: `DROP SCHEMA mastra CASCADE` removes every trace of the
engine and leaves the proposals, their audit trail and the ledger untouched,
because none of those live here.

**Why Alembic creates it rather than the library.** Mastra creates its tables on
first use, which would work - and would put DDL for a shared database in the
hands of whichever process happened to boot first, with no revision history and
no way to review a change before it ran. CLAUDE.md says the AI service owns the
schema; that is the reason, and the orchestrator therefore runs the store with
`disableInit: true` so the library never issues DDL. The cost is that this file
must match what the library expects, so an orchestrator test asserts exactly
that against `WorkflowsPG.getExportDDL()` and fails the build when a Mastra
upgrade changes the shape. Discovering that from a test is the cheap direction;
discovering it from a suspended run that will not resume is not.

**Why only one of Mastra's forty-three tables.** The library's `PostgresStore`
initialises every storage domain it has - agents, memory, datasets, telemetry,
skills - and this project uses exactly one of them, `workflows`. The other
forty-two would be empty tables nobody can explain, so they are not created and
the store is configured to route only the workflows domain here.

Revision ID: 0008_mastra_workflow_state
Revises: 0007_notifications
"""

from alembic import op

revision = "0008_mastra_workflow_state"
down_revision = "0007_notifications"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS mastra")

    # Transcribed from WorkflowsPG.getExportDDL('mastra'), quoting and all. The
    # camelCase column names are the library's and are quoted because Postgres
    # would otherwise fold them to lower case and the store's own queries - which
    # quote them - would not find them.
    #
    # `snapshot` is the entire run: which step is suspended, what it was
    # suspended with, and every step result so far. It is the reason a decision
    # taken tomorrow morning can resume a workflow started this afternoon.
    #
    # The timestamps come in pairs because the library is mid-migration from
    # naive `timestamp` to `timestamptz`: it writes both and reads the `Z`
    # variant when present. Keeping both means a version that reads either one
    # works, which is what allows the library to be upgraded without a data
    # migration on a table full of live suspended runs.
    op.execute(
        """
        CREATE TABLE mastra.mastra_workflow_snapshot (
            "workflow_name" TEXT NOT NULL,
            "run_id"        TEXT NOT NULL,
            "resourceId"    TEXT,
            "snapshot"      JSONB NOT NULL,
            "createdAt"     TIMESTAMP NOT NULL,
            "updatedAt"     TIMESTAMP NOT NULL,
            "createdAtZ"    TIMESTAMPTZ DEFAULT NOW(),
            "updatedAtZ"    TIMESTAMPTZ DEFAULT NOW()
        )
        """
    )

    # A run is identified by (workflow name, run id), and the orchestrator makes
    # the run id the observation id the proposal was raised from. That is what
    # makes starting a lifecycle idempotent: a re-scan that re-raises the same
    # finding cannot open a second workflow for it, for the same reason
    # proposals_one_per_observation stops it opening a second proposal.
    op.execute(
        """
        ALTER TABLE mastra.mastra_workflow_snapshot
            ADD CONSTRAINT mastra_mastra_workflow_snapshot_workflow_name_run_id_key
            UNIQUE (workflow_name, run_id)
        """
    )

    # Mastra sets this on the table it creates, so this migration sets it too: a
    # table that differs from the library's own is a difference somebody has to
    # rediscover later. It only matters under logical replication, where it names
    # the key a downstream consumer identifies a changed row by; the default
    # (the primary key) is unavailable because this table has none.
    op.execute(
        """
        ALTER TABLE mastra.mastra_workflow_snapshot
            REPLICA IDENTITY USING INDEX mastra_mastra_workflow_snapshot_workflow_name_run_id_key
        """
    )

    # The two reads the library actually performs: "the runs of this workflow,
    # newest first" and the same filtered by status - which is how a suspended
    # run is found again after a restart. The status lives inside the snapshot,
    # hence the expression index rather than a column.
    op.execute(
        """
        CREATE INDEX mastra_mastra_workflow_snapshot_name_createdat_idx
            ON mastra.mastra_workflow_snapshot ("workflow_name", "createdAt" DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX mastra_mastra_workflow_snapshot_name_status_createdat_idx
            ON mastra.mastra_workflow_snapshot
               ("workflow_name", (snapshot ->> 'status'), "createdAt" DESC)
        """
    )


def downgrade() -> None:
    # CASCADE, and deliberately not a table-by-table drop: if a later Mastra
    # version has added tables of its own to this schema, a downgrade that
    # dropped only the one this migration created would leave the rest behind
    # with nothing to explain them. The schema is the unit that was added here,
    # so it is the unit that is removed.
    #
    # Suspended runs are lost, and that is the correct trade: the proposals
    # themselves, their transitions and their intents live in `public` and are
    # untouched, and `effectiveState` still answers correctly for every one of
    # them. A downgrade loses the coordinator, not the record.
    op.execute("DROP SCHEMA IF EXISTS mastra CASCADE")
