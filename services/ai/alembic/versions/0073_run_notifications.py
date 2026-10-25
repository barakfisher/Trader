"""A scheduled scan that gave up is announced through the ledger (D74, D298).

`notifications.ref_kind` gains `'run'`, pointing at the `runs` row of the
attempt that gave up. The orchestrator sent that alert straight to the channel,
so a slot that gave up at 03:00 messaged at 03:00 and a muted user still heard
it; through the ledger, quiet hours and a mute hold it for the digest like
anything else, and its dedupe key is (channel, `run`, run id).

`ref_id` carries no foreign key here, as for every other kind. An account reset
keeps these rows, as it keeps the `runs` they point at (0045: bookkeeping).

The downgrade deletes the `run` notifications, which loses only the record that
an alert was sent.

Revision ID: 0073_run_notifications
Revises: 0072_reset_research
"""

from alembic import op

revision = "0073_run_notifications"
down_revision = "0072_reset_research"
branch_labels = None
depends_on = None

#: 0069's notification referents.
PREVIOUS_REF_KINDS = ("observation", "proposal", "narration", "model_fallback")
REF_KINDS = (*PREVIOUS_REF_KINDS, "run")


def _ref_kinds(kinds: tuple[str, ...]) -> None:
    listed = ", ".join(f"'{kind}'" for kind in kinds)
    op.execute("ALTER TABLE notifications DROP CONSTRAINT notifications_ref_kind_check")
    op.execute(
        "ALTER TABLE notifications ADD CONSTRAINT notifications_ref_kind_check "
        f"CHECK (ref_kind IN ({listed}))"
    )


def upgrade() -> None:
    _ref_kinds(REF_KINDS)


def downgrade() -> None:
    op.execute("DELETE FROM notifications WHERE ref_kind = 'run'")
    _ref_kinds(PREVIOUS_REF_KINDS)
