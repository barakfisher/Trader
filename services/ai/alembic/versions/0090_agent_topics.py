"""`agents.topics`: what an agent follows, for its briefing (D412-D414).

D15 promised a briefing with "instruments from the user's followed topics";
it was never built, and the user's agents select no sector or industry, so
nothing told a scan where to look beyond the day's movers. Each agent now
holds up to five short topics ("AI chips", "regional banks"). Each scan
resolves them against the universe, the way `search_universe` does, and the
briefing lists the candidates.

A topic directs where the agent looks. It is not a rule: no trade is refused
for being off-topic, and topics alone do not make an agent ready to scan
(D174).

- `topics text[]`, empty by default: no topics is no section (D414).
- At most `MAX_TOPICS`, each at most `MAX_TOPIC_LENGTH` characters. The
  orchestrator trims and validates; the CHECK on the count catches what
  bypasses it.
- The primary account holds none, like the mandate (0057).

Downgrade drops the column; the topics typed are lost.

Revision ID: 0090_agent_topics
Revises: 0089_upcoming_listings
"""

from alembic import op

revision = "0090_agent_topics"
down_revision = "0089_upcoming_listings"
branch_labels = None
depends_on = None

#: `MAX_TOPICS` and `MAX_TOPIC_LENGTH` in `packages/shared/src/types.ts`;
#: `test_agent_topics.py` holds them equal.
MAX_TOPICS = 5
MAX_TOPIC_LENGTH = 80


def upgrade() -> None:
    op.execute(
        f"""
        ALTER TABLE agents
            ADD COLUMN topics text[] NOT NULL DEFAULT '{{}}'
                CHECK (cardinality(topics) <= {MAX_TOPICS}),
            ADD CONSTRAINT agents_primary_has_no_topics CHECK (NOT is_primary OR topics = '{{}}')
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE agents
            DROP CONSTRAINT agents_primary_has_no_topics,
            DROP COLUMN topics
        """
    )
