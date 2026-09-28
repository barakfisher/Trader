"""Remember narration's state, so a change in it can be announced once.

`GET /narration` recomputes the state on every read, which is right for a badge
and useless for a notification: announcing a *change* needs the previous state,
and nothing stored it. `narration_transitions` is a ledger of changes - one row
each time the state differs from the last row - so its newest row is the
current state and the table as a whole answers "when did explanations stop
being written by the model, and why".

The first row for a user has `from_state IS NULL`. It is a baseline, recorded
and never announced: a deployment is not a transition, and a message saying
"explanations are by template" on the first scan after an upgrade would report
a state the user has had for weeks as news.

`notifications.ref_kind` gains `'narration'`, pointing at a transition. The
notification ledger's dedupe key is (channel, ref_kind, ref_id), so each
transition is announced at most once whatever the scan cadence.

Revision ID: 0022_narration_transitions
Revises: 0021_topic_proposal_expiry
"""

from alembic import op

revision = "0022_narration_transitions"
down_revision = "0021_topic_proposal_expiry"
branch_labels = None
depends_on = None

#: Notification referents 0007 created.
PREVIOUS_REF_KINDS = ("observation", "proposal")

#: Referents after this migration: the previous set plus a narration transition.
REF_KINDS = (*PREVIOUS_REF_KINDS, "narration")

#: `NarrationState` in `services/narrationHealth.ts`, less `unknown`: an unknown
#: state is the absence of a reading, and recording it would make the ledger say
#: something changed when nothing was measured.
STATES = ("off", "narrating", "unavailable", "exhausted", "rejected")


def _replace_ref_kind_check(kinds: tuple[str, ...]) -> None:
    """Point `notifications_ref_kind_check` at exactly `kinds`."""
    op.execute("ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_ref_kind_check")
    op.execute(
        f"ALTER TABLE notifications ADD CONSTRAINT notifications_ref_kind_check "
        f"CHECK (ref_kind IN ({', '.join(repr(kind) for kind in kinds)}))"
    )


def upgrade() -> None:
    states = ", ".join(repr(state) for state in STATES)
    op.execute(
        f"""
        CREATE TABLE narration_transitions (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            -- Null only on a user's first row: the baseline.
            from_state      text CHECK (from_state IN ({states})),
            to_state        text NOT NULL CHECK (to_state IN ({states})),
            -- The fallback reason behind a template state, as recorded on the
            -- observations it was read from. For an operator, not a reader.
            fallback_reason text,
            -- The scan that noticed. Kept after the run is pruned, like
            -- observations.run_id, because the transition is still true.
            run_id          uuid REFERENCES runs(id) ON DELETE SET NULL,
            created_at      timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT narration_transitions_changes
                CHECK (from_state IS DISTINCT FROM to_state)
        )
        """
    )
    op.execute(
        "CREATE INDEX narration_transitions_latest_idx "
        "ON narration_transitions (user_id, created_at DESC)"
    )
    _replace_ref_kind_check(REF_KINDS)


def downgrade() -> None:
    # A notification about a transition has no 0021 referent. It is deleted
    # rather than relabelled: calling it an observation would point `ref_id` at
    # a row of the wrong table, and its transition is dropped just below.
    op.execute("DELETE FROM notifications WHERE ref_kind = 'narration'")
    _replace_ref_kind_check(PREVIOUS_REF_KINDS)
    op.execute("DROP TABLE IF EXISTS narration_transitions")
