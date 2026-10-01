"""Proposal episodes: a standing finding is asked about once (decision 92).

A proposal used to be deduplicated by its observation alone, and an allocation
drift observation's `dedupe_key` changes with each day's valuation - rightly,
since the feed should say "still drifted" each day. But the question followed
the observation: the BTC-USD drift, sitting at 0.149-0.153 all week on the 0.15
"high" line, was proposed seven days running (25 Sep - 1 Oct 2026), once
twenty minutes after the user approved it. Approving writes to the virtual
ledger, so it never changes the drift.

An **episode** is one standing situation for one subject. While it is open, a
new finding of the same kind about the same subject does not raise a proposal.
It closes when the finding falls below the band beneath the proposal floor (the
situation was resolved, with hysteresis wide enough that hovering on the line
does not count), or is reopened when it worsens by one band or changes sign.

- **`proposal_episodes`**, one row per episode, `user_id` like every
  user-owned table. `asked_magnitude` is the signed figure the question was
  asked at (the drift, a `numeric` fraction), so a worsening is measured
  against what the user was shown, not against yesterday.
- **One open episode per user, kind and subject**, by a partial unique index:
  the scan claims the episode before raising, so a concurrent scan cannot ask
  twice.
- **Seeded from each subject's latest proposal**, so the question already in
  the inbox is the episode's opening one. A seed whose drift has since resolved
  is closed by the next scan that sees it below the band - every thirty
  minutes - so a stale seed costs at most one scan.

Revision ID: 0032_proposal_episodes
Revises: 0031_universe_rescreen
"""

from alembic import op

revision = "0032_proposal_episodes"
down_revision = "0031_universe_rescreen"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE proposal_episodes (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            observation_kind text NOT NULL,
            subject_ref text NOT NULL,
            observation_id uuid NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
            asked_magnitude numeric(38, 18) NOT NULL,
            opened_at timestamptz NOT NULL DEFAULT now(),
            closed_at timestamptz,
            close_reason text CHECK (close_reason IN ('resolved', 'worsened', 'reversed')),
            CHECK ((closed_at IS NULL) = (close_reason IS NULL))
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX proposal_episodes_one_open
            ON proposal_episodes (user_id, observation_kind, subject_ref)
         WHERE closed_at IS NULL
        """
    )
    op.execute(
        """
        INSERT INTO proposal_episodes
               (user_id, observation_kind, subject_ref, observation_id, asked_magnitude, opened_at)
        SELECT DISTINCT ON (o.user_id, o.kind, o.subject_ref)
               o.user_id, o.kind, o.subject_ref, o.id,
               (o.evidence->>'drift')::numeric, p.created_at
          FROM proposals p
          JOIN observations o ON o.id = p.observation_id
         WHERE o.kind = 'allocation_drift'
           AND o.evidence ? 'drift'
         ORDER BY o.user_id, o.kind, o.subject_ref, p.created_at DESC
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE proposal_episodes")
