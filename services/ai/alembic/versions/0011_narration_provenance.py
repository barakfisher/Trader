"""Record who wrote each explanation, and why the model did not (M4 debt).

The pipeline has always computed both facts and the insert has always thrown
them away, which is listed as debt in the project memory: *"nothing records
whether a sentence came from the model or a template, so the UI cannot show it
and a reader cannot weigh it."*

A reader weighs a sentence differently depending on its author. A template is
fixed phrasing over checked figures; a model's sentence is prose that passed the
evidence validator. Both are trustworthy about their numbers and they are not
equally informative about anything else, and the feed currently presents them
identically.

`fallback_reason` is the other half, and it is what makes an operator able to
answer *why* narration stopped without reading logs: a spent budget, a refusing
provider, a model whose figures failed the validator. Those are different
problems with different fixes, and today they look alike from the outside.

**Existing rows get NULL, not a guess.** Migration 0002 backfilled unknown
snapshots as `degraded = true` on the reasoning that unknown provenance is
closer to degraded than to trustworthy, and that was right *there* because
`degraded` is a warning: over-warning is safe. This column is not a warning, it
is an attribution. Writing 'template' onto rows nobody recorded would state a
fact about authorship that nobody checked, which is the same class of mistake as
an invented figure (guideline 7). NULL says "not recorded", and the UI is
expected to say that rather than pick a side.

**`fallback_reason` deliberately has no CHECK constraint.** The reasons are
diagnostic, not a state machine, and this migration is written days after
`runs_kind_check` rejected a kind the API could still send and stopped four
migrations from applying. A constraint here would carry the same hazard in a
worse place: a reason nobody anticipated would fail the *write* of an
observation that is otherwise perfectly good, so the cost of the check is
losing a real finding over the spelling of its telemetry.

`narration_source` does get one, and the asymmetry is the point: it answers "who
wrote this", the UI makes a claim to the reader out of it, and a bad value there
is a lie rather than a missing note.

Revision ID: 0011_narration_provenance
Revises: 0010_instrument_metadata
"""

from alembic import op

revision = "0011_narration_provenance"
down_revision = "0010_instrument_metadata"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE observations ADD COLUMN narration_source text")
    op.execute("ALTER TABLE observations ADD COLUMN fallback_reason text")
    op.execute(
        """
        ALTER TABLE observations ADD CONSTRAINT observations_narration_source_check
            CHECK (narration_source IS NULL OR narration_source IN ('llm', 'template'))
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE observations DROP CONSTRAINT observations_narration_source_check")
    op.execute("ALTER TABLE observations DROP COLUMN fallback_reason")
    op.execute("ALTER TABLE observations DROP COLUMN narration_source")
