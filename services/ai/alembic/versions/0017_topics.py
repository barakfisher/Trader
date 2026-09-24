"""Topics, and the instruments the user confirmed for each (FR-10, M5).

`topics` is a theme in the user's own words ("uranium"). `topic_instruments` is
the set of instruments the user *confirmed* for it. Resolution only suggests;
nothing reaches this table without a person choosing it.

**Only confirmed instruments are stored.** DESIGN.md sketched a
`confirmed_by_user` flag, which implies keeping unticked suggestions as rows.
Those rows would be data nobody chose, sitting in the table every later reader
(topicScan, the news matcher, the digest) has to remember to filter. A
suggestion that was not ticked is simply not here. What a row does keep is *why*
it is here.

**Provenance is stored as it was offered, not recomputed.** `source` is
`resolver` or `user` (a ticker the resolver missed and the user added).
Resolver rows keep the band, the quoted sentence and the source ETFs that were
shown when the user confirmed. The topic card can then explain an instrument
months later without re-resolving, and a later universe or threshold change
cannot quietly rewrite the reason someone agreed to. The orchestrator gets
these values by re-resolving on the server at confirm time, never from the
browser: a rationale is a quotation, and a client must not be able to supply
the text that gets called a quotation.

**`user_id` on both tables** (guideline 5). The composite foreign key makes it
impossible for a topic_instruments row to name a different user than its
topic.

**One live topic per label per user**, compared case-insensitively.
`rejected` rows are outside that rule on purpose. They are auto-discovery's
memory (FLOWS F5: a rejected theme must not be proposed again), so a user can
still create a topic whose label they once rejected as a proposal.

**Not in this migration:** backfilling `article_entities.topic_id` from
`topic_ref`, which migration 0004 promised a later migration would do. The
table is empty in every installation (nothing writes topic entities yet), and
how news links to a topic is topicScan's design to make. The promise now
belongs to that migration.

Revision ID: 0017_topics
Revises: 0016_etf_holdings
"""

from alembic import op

revision = "0017_topics"
down_revision = "0016_etf_holdings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE topics (
            id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            -- The user's words, trimmed. Also what is resolved again on edit.
            label        text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
            status       text NOT NULL CHECK (status IN ('active', 'proposed', 'rejected')),
            created_by   text NOT NULL CHECK (created_by IN ('user', 'auto')),
            created_at   timestamptz NOT NULL DEFAULT now(),
            updated_at   timestamptz NOT NULL DEFAULT now(),
            -- When the user last confirmed the instrument set. Null for a
            -- proposal nobody has confirmed yet.
            confirmed_at timestamptz,
            CONSTRAINT topics_active_is_confirmed
                CHECK (status <> 'active' OR confirmed_at IS NOT NULL),
            -- The target of topic_instruments' composite key.
            CONSTRAINT topics_id_user_uniq UNIQUE (id, user_id)
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX topics_live_label_per_user
            ON topics (user_id, lower(label)) WHERE status <> 'rejected'
        """
    )
    op.execute(
        """
        CREATE TABLE topic_instruments (
            topic_id      uuid NOT NULL,
            user_id       uuid NOT NULL,
            instrument_id uuid NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
            source        text NOT NULL CHECK (source IN ('resolver', 'user')),
            -- A band, never a percentage: a cosine is not a probability.
            confidence    text CHECK (confidence IN ('confident', 'weak')),
            -- A sentence from the instrument's own description, verbatim.
            rationale     text,
            -- The source ETFs that held it when it was offered:
            -- [{"etf": "URA", "weight": "0.2195"}], weights as decimal strings.
            held_by       jsonb NOT NULL DEFAULT '[]'::jsonb,
            added_at      timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (topic_id, instrument_id),
            FOREIGN KEY (topic_id, user_id) REFERENCES topics (id, user_id) ON DELETE CASCADE,
            -- A resolver row carries its reasons. A user row has none to carry,
            -- and must not be given any: an empty rationale would read as
            -- "the resolver had nothing to say", which is not what happened.
            CONSTRAINT topic_instruments_provenance CHECK (
                (source = 'resolver' AND confidence IS NOT NULL AND rationale IS NOT NULL)
                OR
                (source = 'user' AND confidence IS NULL AND rationale IS NULL
                 AND held_by = '[]'::jsonb)
            ),
            CONSTRAINT topic_instruments_held_by_is_list CHECK (jsonb_typeof(held_by) = 'array')
        )
        """
    )
    # topicScan and the news matcher ask "which topics is this instrument in?".
    op.execute("CREATE INDEX topic_instruments_instrument ON topic_instruments (instrument_id)")


def downgrade() -> None:
    op.execute("DROP TABLE topic_instruments")
    op.execute("DROP TABLE topics")
