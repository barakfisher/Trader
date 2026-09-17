"""Proposals, their audit trail, the paper ledger, and per-user settings (M4).

Four tables that together turn an observation the user reads into a decision the
user made, without ever placing an order.

**Amended after this migration was merged, because it could not be applied.**
It rewrote `runs_kind_check` by retyping the list of kinds, and the retyped list
omitted `backfill` - the kind migration 0005 exists entirely to add. Every
database holding a backfill run therefore refused this migration and stopped at
0005, taking 0007 to 0009 with it: the whole M4 schema was unreachable on any
installation that had ever backfilled prices. The amendment is made here rather
than in a later migration because a later one is never reached - the failure
happens *inside* this file, so nothing after it can repair anything.

Two things let it through, and both generalise. A migration that rewrites an
enumeration by retyping it will eventually drop a value, which is why the list
is now a named tuple extended from 0005's rather than a literal. And **a CHECK
constraint is only exercised by data**, so a CI run that migrates an empty
database proves the SQL parses and nothing else; the constraint that matters is
the one applied to rows that already exist.

`proposals` is the state machine from FLOWS.md F3. Its states are a CHECK rather
than an enum type: adding a state to a Postgres enum is a migration either way,
and a text column is one `psql` line to inspect.

`proposal_transitions` is the part DESIGN.md's sketch did not have. That sketch
carried `decided_at`/`decided_via` on the proposal itself, which records *a*
decision but cannot record a history: a proposal that is snoozed at 09:00, wakes
at 17:00 and is approved at 17:02 has three transitions and one of those columns.
F3 requires every transition to write an immutable row with its surface, actor
and the evidence the decision was made on, which is a table. The columns on
`proposals` are then a cache of the latest transition, kept because the inbox
query should not have to aggregate the audit log to render a list.

`intents` is the ledger, and it is the reason this milestone can exist at all
under guideline 2: approving a proposal writes a row here and nothing else. There
is no broker client to forget to disable, because there is no broker client. The
`payload` is the shape of the action the user assented to, not an order.

`user_settings` moves the human-facing knobs out of environment variables. The
analysis thresholds stay in config - they describe how the engine reads a market
and are an operator's concern - while what reaches the user, and when, is the
user's. One row per user, created on demand: a missing row means the defaults
below, so a user who never opens the settings page is not a special case.

It also takes over `users.quiet_hours`, which 0001 created as an unvalidated
jsonb blob and which nothing has ever read. Leaving it there and adding the rest
of the notification settings here would give one concept two homes, and the two
would eventually disagree - so the column is migrated into typed `time` columns
and dropped. Typed, because `{"start": "22:00"}` with no `end` is representable
in jsonb and refusable in SQL. `users.timezone` stays where it is: it is the
identity of a user's day and is read by everything that resolves "today", not a
notification preference.

Revision ID: 0006_proposals_and_settings
Revises: 0005_backfill_run_kind
"""

from alembic import op

revision = "0006_proposals_and_settings"
down_revision = "0005_backfill_run_kind"
branch_labels = None
depends_on = None

#: The run kinds 0005 left behind. Named so this migration's downgrade restores
#: what was actually there, rather than a list somebody retyped from memory.
PREVIOUS_KINDS = ("snapshot", "portfolio_scan", "topic_scan", "daily_digest", "backfill")

#: Kinds after this migration: the previous set plus the sweep. Adding a kind
#: means extending this tuple, never rewriting the literal.
KINDS = (*PREVIOUS_KINDS, "proposal_sweep")


def _replace_run_kind_check(kinds: tuple[str, ...]) -> None:
    """Point `runs_kind_check` at exactly `kinds`.

    One place builds the SQL, so the constraint can only ever say what a named
    tuple says. The bug this replaces was a second hand-written copy of the list
    that had quietly fallen behind the first.
    """
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check")
    op.execute(
        f"ALTER TABLE runs ADD CONSTRAINT runs_kind_check "
        f"CHECK (kind IN ({', '.join(repr(kind) for kind in kinds)}))"
    )


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE user_settings (
            -- The primary key is the user: there is exactly one settings row per
            -- user, or none, and none means the defaults below.
            user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

            -- The floor at which an observation becomes something to approve or
            -- reject rather than something to read. 'high' by default because a
            -- proposal asks for attention, and the feed already carries the rest.
            proposal_severity   text NOT NULL DEFAULT 'high'
                                CHECK (proposal_severity IN ('info','notable','high')),

            -- How long a proposal stays answerable. A decision taken against
            -- prices that have moved is a different decision, so proposals
            -- expire rather than waiting indefinitely.
            proposal_ttl_hours  integer NOT NULL DEFAULT 24
                                CHECK (proposal_ttl_hours BETWEEN 1 AND 168),

            -- The floor for an immediate push. Separate from proposal_severity
            -- on purpose: "what I must answer" and "what may interrupt me" are
            -- different questions, and collapsing them forces one to be wrong.
            notify_severity     text NOT NULL DEFAULT 'high'
                                CHECK (notify_severity IN ('info','notable','high')),

            -- Local wall-clock window during which nothing is pushed. Both null
            -- means no quiet hours at all; the default is the one 0001 shipped
            -- on users.quiet_hours, kept deliberately so this migration moves a
            -- setting without changing anybody's nights. Stored as `time` rather
            -- than an hour integer so 22:30 is expressible, and interpreted in
            -- users.timezone - a quiet-hours window in UTC is quiet at the wrong
            -- time for half the year. A window that wraps midnight is the normal
            -- case, and is handled in the query rather than forbidden here.
            quiet_hours_start   time DEFAULT '22:00',
            quiet_hours_end     time DEFAULT '07:00',

            -- Set by /mute: nothing is pushed until this passes, regardless of
            -- quiet hours or severity. Distinct from quiet hours because it is a
            -- one-off ("not for the next two hours") rather than a recurring
            -- window, and a one-off written as a recurring rule never gets
            -- unwritten.
            muted_until         timestamptz,

            updated_at          timestamptz NOT NULL DEFAULT now(),

            -- Quiet hours are a window, so either both ends are set or neither
            -- is. A half-set window has no defensible reading, and the database
            -- is the only place that can refuse one from every writer at once.
            CONSTRAINT user_settings_quiet_hours_are_a_pair
                CHECK ((quiet_hours_start IS NULL) = (quiet_hours_end IS NULL))
        )
        """
    )

    # Carry the old blob across before dropping it. Nothing reads the column
    # today and v1 is a single account, so this moves one row at most - but a
    # migration that silently discards a setting somebody chose is the wrong
    # habit to establish, and not establishing it costs four lines.
    #
    # Only a value that differs from the default is worth a row: a user still on
    # 22:00-07:00 because nobody ever changed it gets the same nights either
    # way, and storing a copy of a default is how a default stops being one.
    # A malformed blob (0001 put no constraint on it, so a half-set window is
    # representable) is skipped rather than coerced, and the user falls back to
    # the default - the alternative is inventing the missing end of a window.
    op.execute(
        """
        INSERT INTO user_settings (user_id, quiet_hours_start, quiet_hours_end)
        SELECT id,
               (quiet_hours ->> 'start')::time,
               (quiet_hours ->> 'end')::time
          FROM users
         WHERE quiet_hours ->> 'start' IS NOT NULL
           AND quiet_hours ->> 'end' IS NOT NULL
           AND (quiet_hours ->> 'start', quiet_hours ->> 'end') <> ('22:00', '07:00')
        """
    )
    op.execute("ALTER TABLE users DROP COLUMN quiet_hours")

    op.execute(
        """
        CREATE TABLE proposals (
            id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

            -- The finding this asks about. CASCADE rather than SET NULL, unlike
            -- observations.run_id: an observation is a fact that outlives its
            -- run, but a proposal with no observation is a question with no
            -- subject, and its evidence snapshot below is not a replacement -
            -- that is what the decision was made on, not what is true now.
            observation_id uuid NOT NULL REFERENCES observations(id) ON DELETE CASCADE,

            -- One open question per finding. observations.dedupe_key already
            -- makes a repeated finding a no-op, so this makes a repeated
            -- *proposal* one too, without a second hashing scheme to keep in
            -- step with the first.
            CONSTRAINT proposals_one_per_observation UNIQUE (observation_id),

            kind         text NOT NULL,
            -- The action being assented to, in the shape the ledger will record.
            payload      jsonb NOT NULL DEFAULT '{}'::jsonb,

            state        text NOT NULL DEFAULT 'pending'
                         CHECK (state IN ('pending','approved','rejected','snoozed','expired')),

            -- Wall-clock deadline, not a duration: a TTL relative to creation
            -- would have to be recomputed by every reader, and two readers would
            -- eventually disagree about whether this is still answerable.
            expires_at   timestamptz NOT NULL,
            -- When a snooze ends. Meaningful only while state = 'snoozed'.
            snoozed_until timestamptz,

            -- A cache of the newest proposal_transitions row, for the inbox
            -- list. The audit log is the record; these are derived.
            decided_at   timestamptz,
            decided_via  text CHECK (decided_via IN ('web','telegram','system')),

            created_at   timestamptz NOT NULL DEFAULT now(),
            updated_at   timestamptz NOT NULL DEFAULT now(),

            -- A snooze past the expiry is not a snooze, it is an expiry with
            -- extra steps: the proposal would wake already dead. Refused here so
            -- no surface can write one.
            CONSTRAINT proposals_snooze_within_ttl
                CHECK (snoozed_until IS NULL OR snoozed_until <= expires_at)
        )
        """
    )
    # The inbox: open questions, soonest deadline first. Partial, because
    # answered proposals are the overwhelming majority over time and none of
    # them belong in this query.
    op.execute(
        """
        CREATE INDEX proposals_open_idx ON proposals (user_id, expires_at)
            WHERE state IN ('pending','snoozed')
        """
    )
    # The sweep that expires and wakes proposals scans by deadline across users.
    op.execute(
        """
        CREATE INDEX proposals_due_idx ON proposals (expires_at)
            WHERE state IN ('pending','snoozed')
        """
    )

    op.execute(
        """
        CREATE TABLE proposal_transitions (
            id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
            user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

            from_state  text NOT NULL,
            to_state    text NOT NULL,

            -- Where the decision came in. 'system' is the expiry sweep and the
            -- snooze wake-up, which are transitions nobody made and which must
            -- still be visible as such: an audit trail that only records human
            -- acts cannot explain why a proposal the user never saw is expired.
            surface     text NOT NULL CHECK (surface IN ('web','telegram','system')),
            -- Who, when that is knowable. Null for a system transition rather
            -- than a sentinel string, so "nobody did this" is not spelled the
            -- same way as a user whose id happens to be 'system'.
            actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

            -- What the decision was made against. Copied, not referenced: the
            -- observation's evidence is the state of the world at scan time and
            -- nothing rewrites it today, but an audit row that can be changed by
            -- a later write somewhere else is not an audit row.
            evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,

            -- The single-use token a Telegram callback carried, so a replay is
            -- identifiable as the same act rather than a second one. Unique
            -- where present: this is what makes "a forwarded message is not an
            -- approval" a database guarantee rather than a code path.
            idempotency_key text,

            created_at  timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX proposal_transitions_idempotency_idx
            ON proposal_transitions (idempotency_key)
            WHERE idempotency_key IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX proposal_transitions_history_idx
            ON proposal_transitions (proposal_id, created_at DESC)
        """
    )

    op.execute(
        """
        CREATE TABLE intents (
            id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

            -- RESTRICT, not CASCADE: the ledger is the record of what the user
            -- assented to, and deleting the question must not delete the answer.
            -- If a proposal ever needs deleting, its intents have to be dealt
            -- with deliberately.
            proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE RESTRICT,

            -- Exactly one intent per proposal. Approval is idempotent (F3), so a
            -- second tap on the same button must not write a second ledger row -
            -- and the cheapest way to guarantee that is to make it impossible.
            CONSTRAINT intents_one_per_proposal UNIQUE (proposal_id),

            kind        text NOT NULL,
            payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at  timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX intents_ledger_idx ON intents (user_id, created_at DESC)")

    # `proposal_sweep` joins the run kinds. The sweep is scheduled work, so it
    # enters through POST /internal/runs like everything else - a bare timer in
    # the orchestrator would never fire under Kubernetes, where the local
    # scheduler is switched off and a CronJob calls that endpoint instead. That
    # is decision 9 in the project memory, and the cost of ignoring it is a
    # sweep that works in development and silently never runs in production.
    #
    # KINDS is the previous migration's list plus this one's addition, and it is
    # named rather than retyped. The first version of this block retyped the
    # list and dropped 'backfill' - the kind 0005 exists entirely to add - so
    # every database holding a backfill run refused this migration and stopped
    # at 0005. See the module docstring.
    _replace_run_kind_check(KINDS)


def downgrade() -> None:
    # Drop any sweep rows before narrowing the constraint back, or the ALTER
    # fails on data the older schema cannot describe. Only the sweep rows: this
    # migration added exactly one kind, so it takes exactly one kind away.
    op.execute("DELETE FROM runs WHERE kind = 'proposal_sweep'")
    _replace_run_kind_check(PREVIOUS_KINDS)

    # Put users.quiet_hours back before the table holding the values goes away,
    # so a downgrade loses the proposals but not the preference.
    op.execute(
        """
        ALTER TABLE users ADD COLUMN quiet_hours jsonb NOT NULL
            DEFAULT '{"start": "22:00", "end": "07:00"}'::jsonb
        """
    )
    op.execute(
        """
        UPDATE users u
           SET quiet_hours = jsonb_build_object(
                   'start', to_char(s.quiet_hours_start, 'HH24:MI'),
                   'end',   to_char(s.quiet_hours_end,   'HH24:MI'))
          FROM user_settings s
         WHERE s.user_id = u.id
           AND s.quiet_hours_start IS NOT NULL
           AND s.quiet_hours_end IS NOT NULL
        """
    )

    # Reverse order of creation: intents and transitions reference proposals.
    op.execute("DROP TABLE IF EXISTS intents")
    op.execute("DROP TABLE IF EXISTS proposal_transitions")
    op.execute("DROP TABLE IF EXISTS proposals")
    op.execute("DROP TABLE IF EXISTS user_settings")
