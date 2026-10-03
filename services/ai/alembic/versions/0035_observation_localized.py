"""An observation's words in the languages besides English (decision 98).

`observations.localized` is `{"he": {"headline": ..., "explanation": ...}}`:
the deterministic template rendered in each translated language when the
observation is written (`app/narration/localized.py`). `headline` and
`explanation` stay the English of record, whoever wrote them, so nothing that
reads them today changes.

- **Rendered at write time, not at read time.** The feed is served by the
  orchestrator, in TypeScript. Rendering on read would mean a second copy of
  the templates there, free to drift from this one, or a call to this service
  on every page load. The evidence is immutable, so a sentence rendered once
  from it is as true later as it was then.
- **jsonb keyed by language, not a column per language.** A language is a
  catalogue and a widening of `user_settings.language`; it should not also be
  a migration on the largest text table.
- **NOT NULL, default `{}`.** An empty map is "no translation", and a reader
  falls back to the English it already has. A row the backfill cannot render
  is left that way rather than failing the migration: English is a correct
  answer for it, and a finding is not worth losing over its Hebrew.

The backfill imports the templates. That is safe here and nowhere later: the
migration runs in the AI image beside them, and a database created after this
revision has no observations for it to read, so its output depends only on the
templates as they were when it ran on an existing installation. The rows were
measured before writing it: every stored observation re-rendered from its
evidence without an error (78 of 78, 2026-10-02).

Revision ID: 0035_observation_localized
Revises: 0034_user_language
"""

import json
from datetime import UTC, datetime

import sqlalchemy as sa

from alembic import op

revision = "0035_observation_localized"
down_revision = "0034_user_language"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE observations ADD COLUMN localized jsonb NOT NULL DEFAULT '{}'::jsonb")
    _backfill()


def _backfill() -> None:
    from app.analysis.findings import Finding
    from app.narration.localized import localize

    connection = op.get_bind()
    rows = connection.execute(
        sa.text("SELECT id, kind, severity, subject_ref, evidence FROM observations")
    ).mappings()
    for row in rows.all():
        finding = Finding(
            kind=row["kind"],
            severity=row["severity"],
            subject_ref=row["subject_ref"] or "",
            as_of=datetime.now(UTC),
            evidence=dict(row["evidence"] or {}),
        )
        try:
            localized = localize(finding)
        except (KeyError, TypeError, ValueError, ArithmeticError):
            continue
        connection.execute(
            sa.text("UPDATE observations SET localized = CAST(:localized AS jsonb) WHERE id = :id"),
            {"localized": json.dumps(localized, ensure_ascii=False), "id": row["id"]},
        )


def downgrade() -> None:
    op.execute("ALTER TABLE observations DROP COLUMN IF EXISTS localized")
