"""Auto-discovered topic proposals, and the memory of the ones the user rejected (FR-11, M5).

A proposal is a `topics` row with `status = 'proposed'` and `created_by = 'auto'`
(migration 0017 anticipated both values). This migration adds what a proposal
has to carry that a topic the user typed does not:

- `evidence` - why it was proposed: the recurring phrase, how many distinct
  headlines and sources used it, a few of those headlines verbatim, and the
  symbols the resolver was confident about. Nothing in a proposal is invented,
  so the card shown to the user is built from this and nothing else.
- `match_words` and `proposed_instruments` - the proposal's fingerprint, stored
  as it was when proposed. The instruments are *every* candidate it offered,
  weak ones included: on the real resolver the confident few rarely overlap
  between two wordings of one theme, and the full lists do. Rejection memory
  compares a new proposal against it: **suppressed if every word of the
  rejected label appears in the new one, or if at least half of the new
  proposal's instruments were in the rejected set**
  (`apps/orchestrator/src/services/topicMatching.ts`). Both are frozen rather
  than recomputed, because recomputing either would let a change to the word
  rules or to the universe quietly un-reject something.
- `rejected_at` - when the user said no. **Memory is a cooldown, not forever**
  (a user decision on 2026-09-27): a rejected theme is suppressed for
  `TOPIC_REJECTION_COOLDOWN_DAYS` and may be proposed again after that, because
  what a person is interested in changes. The row itself is never deleted -
  decision 18's ledger argument: remember, do not delete - so the history of
  what was rejected, and when, survives the cooldown.

**Instruments of a proposal are not `topic_instruments` rows.** Decision 49 keeps
that table to instruments a person confirmed. A proposal's instrument set is
the resolver's offer, so it lives on the proposal as an array; accepting one
goes through the ordinary confirm, which re-resolves and writes the rows.

**A run kind, `topic_discovery`**, extended the way 0018 extended it: `KINDS`
is the previous tuple plus this one's addition.

Revision ID: 0019_topic_discovery
Revises: 0018_news_collect
"""

from alembic import op

revision = "0019_topic_discovery"
down_revision = "0018_news_collect"
branch_labels = None
depends_on = None

#: The run kinds 0018 left behind.
PREVIOUS_KINDS = (
    "snapshot",
    "portfolio_scan",
    "topic_scan",
    "daily_digest",
    "backfill",
    "proposal_sweep",
    "instrument_metadata",
    "news_collect",
)

#: Kinds after this migration: the previous set plus auto-discovery.
KINDS = (*PREVIOUS_KINDS, "topic_discovery")


def _replace_run_kind_check(kinds: tuple[str, ...]) -> None:
    """Point `runs_kind_check` at exactly `kinds`."""
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check")
    op.execute(
        f"ALTER TABLE runs ADD CONSTRAINT runs_kind_check "
        f"CHECK (kind IN ({', '.join(repr(kind) for kind in kinds)}))"
    )


#: `matchWords`' filler list in `topicMatching.ts`, frozen as of this migration: a
#: later change to the list must not change what this backfill wrote.
_FILLER_WORDS = (
    "a", "an", "and", "the", "of", "in", "on", "for", "to", "with", "its", "it", "is",
    "are", "as", "by", "or", "at", "from", "that", "this",
    "company", "companies", "inc", "corporation",
    "stock", "stocks", "share", "shares", "sector", "industry", "theme", "market",
    "markets", "play", "plays", "etf", "etfs", "fund", "funds",
)  # fmt: skip


def upgrade() -> None:
    _replace_run_kind_check(KINDS)
    op.execute(
        """
        ALTER TABLE topics
            ADD COLUMN rejected_at          timestamptz,
            ADD COLUMN match_words          text[],
            ADD COLUMN proposed_instruments uuid[],
            ADD COLUMN evidence             jsonb
        """
    )
    # Auto topics already present get a fingerprint before the CHECK below
    # demands one. None exist on a first upgrade; they exist after a rollback
    # below this revision and forward again, because the downgrade keeps
    # proposals and rejections and drops only these columns - and without this
    # backfill that round trip could never be completed. Found by the Postgres
    # integration job, the first thing ever to try it with a proposal present.
    #
    # The words follow `matchWords` (lower-case, filler removed, plurals folded,
    # distinct, sorted), so a restored rejection still suppresses its theme by
    # words. Its instruments are unrecoverable - the offer lived only in the
    # dropped column - so the set is empty, and matching by instruments stops
    # for that row. The rejection time falls back to the last update.
    fillers = ", ".join(repr(word) for word in _FILLER_WORDS)
    op.execute(
        f"""
        UPDATE topics AS t
           SET match_words = coalesce((
                   SELECT array_agg(DISTINCT folded ORDER BY folded)
                     FROM (
                           SELECT CASE WHEN length(w) > 3 AND w LIKE '%s' AND w NOT LIKE '%ss'
                                       THEN left(w, -1) ELSE w END AS folded
                             FROM (SELECT m[1] AS w
                                     FROM regexp_matches(lower(t.label), '([a-z0-9]+)', 'g') AS m
                                  ) AS words
                            WHERE w NOT IN ({fillers})
                          ) AS significant
               ), '{{}}'),
               proposed_instruments = '{{}}',
               evidence = '{{}}'::jsonb,
               rejected_at = CASE WHEN t.status = 'rejected' THEN t.updated_at END
         WHERE t.created_by = 'auto'
        """
    )
    op.execute(
        """
        ALTER TABLE topics
            -- `rejected` and a rejection time go together, in both directions:
            -- a cooldown measured from a missing time would never end.
            ADD CONSTRAINT topics_rejected_has_time
                CHECK ((status = 'rejected') = (rejected_at IS NOT NULL)),
            -- Only a proposal can be rejected. A topic the user created is
            -- deleted, not rejected; there is nothing to stop re-proposing.
            ADD CONSTRAINT topics_rejected_is_auto
                CHECK (status <> 'rejected' OR created_by = 'auto'),
            -- An auto topic without its fingerprint could be rejected and then
            -- proposed again the next day, which is the one thing memory is for.
            ADD CONSTRAINT topics_auto_has_fingerprint
                CHECK (created_by <> 'auto' OR (
                    match_words IS NOT NULL
                    AND proposed_instruments IS NOT NULL
                    AND evidence IS NOT NULL
                    AND jsonb_typeof(evidence) = 'object'
                ))
        """
    )
    # Discovery reads "what did this user reject recently?" once per run.
    op.execute(
        """
        CREATE INDEX topics_rejected_recent
            ON topics (user_id, rejected_at) WHERE status = 'rejected'
        """
    )


def downgrade() -> None:
    # Proposals and rejections stay: without the new columns each is still a
    # valid 0017 row. What is lost is their fingerprints and rejection times,
    # so after a downgrade rejection memory has nothing to compare against.
    op.execute("DELETE FROM runs WHERE kind = 'topic_discovery'")
    _replace_run_kind_check(PREVIOUS_KINDS)
    op.execute("DROP INDEX IF EXISTS topics_rejected_recent")
    op.execute(
        """
        ALTER TABLE topics
            DROP CONSTRAINT topics_auto_has_fingerprint,
            DROP CONSTRAINT topics_rejected_is_auto,
            DROP CONSTRAINT topics_rejected_has_time,
            DROP COLUMN evidence,
            DROP COLUMN proposed_instruments,
            DROP COLUMN match_words,
            DROP COLUMN rejected_at
        """
    )
