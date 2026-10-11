"""Finding episodes: a standing state is written when it crosses a band (decision 132).

Drawdown and allocation drift are *states*, but the feed dated them like events:
the dedupe key buckets by the day of the latest price, so a holding sitting 25%
below its high was written once a day for as long as it sat there. Measured on
kind, 2026-10-09: 14 drawdown observations for two holdings over ten days, where
SMR alone said "high drawdown" seven times about one fall.

An **episode** is one stretch of a subject being in a state. While it is open,
a finding of the same kind about the same subject is written only when its band
is higher than the highest one the episode has written. The episode closes when
a scan in which the rule ran sees the subject below the `info` band - nothing
found - and the next entry opens a new one.

- **`finding_episodes`**, `user_id` and `agent_id` like every owned table, with
  the composite foreign key to `agents` the other owned tables carry.
- **`severity`** is the highest band written in the episode. A recovery to a
  lower band writes nothing and leaves it where it was.
- **`observation_id`** is the observation that wrote that band, `ON DELETE
  CASCADE`: when `reset_account` erases the observations, their episodes go with
  them, so 0045's function needs no change. An episode is derived state; losing
  one costs at most one repeated finding, never a wrong one.
- **One open episode per agent, kind and subject**, by a partial unique index,
  so two concurrent scans cannot both open one.
- **Seeded** from each subject's latest drawdown or drift observation of the
  last three days, so a state that is standing at deploy time is not written
  again the next morning. A seed for a state that has since ended is closed by
  the next scan that sees it gone - every thirty minutes.

Not to be confused with `proposal_episodes` (0032, decision 92): that one
decides whether to *ask*; this one decides whether to *say*. Both stay.

Revision ID: 0049_finding_episodes
Revises: 0048_agent_scan_runs
"""

from alembic import op

revision = "0049_finding_episodes"
down_revision = "0048_agent_scan_runs"
branch_labels = None
depends_on = None

#: The finding kinds that are states rather than events. The AI service's
#: `STATE_KINDS` is tested against this.
STATE_KINDS = ("drawdown", "allocation_drift")


def upgrade() -> None:
    kinds = ", ".join(f"'{kind}'" for kind in STATE_KINDS)
    op.execute(
        f"""
        CREATE TABLE finding_episodes (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            agent_id uuid NOT NULL,
            kind text NOT NULL CHECK (kind IN ({kinds})),
            subject_ref text NOT NULL,
            severity text NOT NULL CHECK (severity IN ('info', 'notable', 'high')),
            observation_id uuid NOT NULL REFERENCES observations (id) ON DELETE CASCADE,
            opened_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            closed_at timestamptz,
            FOREIGN KEY (user_id, agent_id) REFERENCES agents (user_id, id)
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX finding_episodes_one_open
            ON finding_episodes (agent_id, kind, subject_ref)
         WHERE closed_at IS NULL
        """
    )
    op.execute(
        f"""
        INSERT INTO finding_episodes
               (user_id, agent_id, kind, subject_ref, severity, observation_id,
                opened_at, updated_at)
        SELECT DISTINCT ON (agent_id, kind, subject_ref)
               user_id, agent_id, kind, subject_ref, severity, id, created_at, created_at
          FROM observations
         WHERE kind IN ({kinds})
           AND subject_ref IS NOT NULL
           AND created_at > now() - interval '3 days'
         ORDER BY agent_id, kind, subject_ref, created_at DESC
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE finding_episodes")
