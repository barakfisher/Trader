"""News corpus: articles, their entity links and their sentiment (FR-7, FR-12).

The three tables the news layer of the analysis pipeline writes (DESIGN.md
section 5, step 4). They are deliberately split along the line between fact and
opinion: `articles` is what was published, `article_entities` is what we believe
it is about, and `article_sentiment` is what a model thought of it. The first is
immutable, the other two are derived and are expected to be recomputed.

None of these tables carries `user_id`, which is the one place this schema
departs from the convention established in 0001. An article is not user-owned:
the same wire story is the same row for every account, and copying it per user
would multiply the corpus by the user count while making "have we already seen
this URL?" a per-user question that it is not. The path to a user runs
article -> article_entities -> instruments -> holdings, and the user-owned row
is the `observation` the pipeline emits at the end of it.

Revision ID: 0004_news
Revises: 0003_runs_and_observations
"""

from alembic import op

revision = "0004_news"
down_revision = "0003_runs_and_observations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE articles (
            id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            -- Two hashes because there are two distinct duplicates to catch, and
            -- neither one catches the other's case:
            --   * `url_hash` is over the NORMALISED url (app/news/dedupe.py) and
            --     catches re-fetching the same story - the scheduled run every
            --     30 minutes, the same link arriving from two queries, the same
            --     link with a newsletter's utm_* parameters bolted on.
            --   * `content_hash` is over the normalised BODY TEXT and catches
            --     the same story living at several urls: a wire item republished
            --     by three outlets under three headlines. The body is hashed
            --     without the title precisely because syndication re-headlines.
            -- Only `url_hash` is unique. A content collision is a real, separate
            -- article that happens to say the same thing, and the pipeline links
            -- it to the first copy rather than refusing to store it - see
            -- `duplicate_of_id` below.
            url_hash     text NOT NULL UNIQUE,
            url          text NOT NULL,
            source       text NOT NULL,
            published_at timestamptz,
            title        text NOT NULL,
            raw_text     text NOT NULL,
            content_hash text NOT NULL,
            -- Set when this row's `content_hash` was already held by an earlier
            -- article: the near-duplicate is kept (its url and outlet are facts)
            -- but points at the copy that the analysis layer should read, so one
            -- story syndicated five times cannot be counted as five signals.
            duplicate_of_id uuid REFERENCES articles(id) ON DELETE SET NULL,
            -- When we retrieved it, as distinct from when it was published.
            -- Both matter: `published_at` dates the event, `fetched_at` dates
            -- our knowledge of it, and a run that explains a price move may only
            -- cite news it could actually have seen.
            fetched_at   timestamptz NOT NULL DEFAULT now(),
            created_at   timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    # The feed and the correlation step both read "recent articles", newest first.
    op.execute("CREATE INDEX articles_published_idx ON articles (published_at DESC)")
    # Content-hash lookups are the dedupe hot path; non-unique for the reason above.
    op.execute("CREATE INDEX articles_content_hash_idx ON articles (content_hash)")

    op.execute(
        """
        CREATE TABLE article_entities (
            id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            article_id    uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
            entity_kind   text NOT NULL CHECK (entity_kind IN ('instrument','topic')),
            -- An instrument link is a foreign key. A topic link is not: `topics`
            -- does not exist until Milestone 5 (PRD FR-10), and adding the table
            -- early - unused, unqueried and guessed at - would fix its shape
            -- before the feature that needs it is designed. So a topic is
            -- referenced by its free-text label here, and the Milestone 5
            -- migration backfills `topic_id` from these labels and adds the key
            -- then. The CHECK below is what keeps that backfill possible: it
            -- guarantees exactly one of the two references is populated, so no
            -- row can be half-instrument and half-topic in the meantime.
            instrument_id uuid REFERENCES instruments(id) ON DELETE CASCADE,
            topic_ref     text,
            CHECK (
                (entity_kind = 'instrument' AND instrument_id IS NOT NULL AND topic_ref IS NULL)
                OR
                (entity_kind = 'topic' AND topic_ref IS NOT NULL AND instrument_id IS NULL)
            ),
            -- How strongly the article is about this entity, 0..1. Derived from
            -- the match method and where in the article the mention fell; see
            -- app/news/entities.py. It ranks the evidence behind an explanation,
            -- it is not a probability.
            salience      numeric(5, 4) NOT NULL DEFAULT 0
                          CHECK (salience >= 0 AND salience <= 1),
            -- Which rule made the link, kept because the link is evidence and
            -- evidence without its provenance cannot be audited. A wrong link is
            -- worse than a missing one, so when a false positive is found this
            -- column says which rule to fix.
            match_method  text NOT NULL
                          CHECK (match_method IN ('cashtag','exchange_prefix','company_name')),
            -- The exact span that matched, for the same reason.
            matched_text  text,
            created_at    timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX article_entities_article_idx ON article_entities (article_id)")
    op.execute(
        "CREATE INDEX article_entities_instrument_idx "
        "ON article_entities (instrument_id, created_at DESC)"
    )
    # One link per (article, entity). Two partial indexes rather than one over
    # both columns: in a plain UNIQUE, NULLs are distinct, so the unused half of
    # every row would make the constraint vacuous and let duplicates through.
    op.execute(
        "CREATE UNIQUE INDEX article_entities_instrument_uniq "
        "ON article_entities (article_id, instrument_id) WHERE instrument_id IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX article_entities_topic_uniq "
        "ON article_entities (article_id, topic_ref) WHERE topic_ref IS NOT NULL"
    )

    op.execute(
        """
        CREATE TABLE article_sentiment (
            id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
            -- Direction, -1 (negative) to +1 (positive).
            score      numeric(5, 4) NOT NULL CHECK (score >= -1 AND score <= 1),
            -- Strength, 0..1, independent of direction. An article with balanced
            -- strong claims scores near 0 with high magnitude; an article about
            -- nothing in particular scores near 0 with low magnitude. One number
            -- cannot say both, and collapsing them would make "neutral" and
            -- "contested" indistinguishable.
            magnitude  numeric(5, 4) NOT NULL DEFAULT 0
                       CHECK (magnitude >= 0 AND magnitude <= 1),
            -- Which scorer produced this, e.g. 'lexicon-v1'. Its own table and
            -- its own row per model rather than columns on `articles`, because
            -- sentiment is a computed opinion with a shelf life: replacing the
            -- lexicon with an LLM scorer must be able to write a second opinion
            -- beside the first, keep the article row untouched (it is a fact,
            -- not a judgement), and let a reader see which model said what. As
            -- columns, a re-score would be a destructive UPDATE over the corpus
            -- with no way back and no way to compare.
            model      text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            -- At most one current opinion per model per article: re-scoring is
            -- an upsert on this key, so a re-run cannot accumulate copies
            -- (guideline 8).
            UNIQUE (article_id, model)
        )
        """
    )
    op.execute("CREATE INDEX article_sentiment_article_idx ON article_sentiment (article_id)")


def downgrade() -> None:
    # Children first: both reference `articles`.
    op.execute("DROP TABLE IF EXISTS article_sentiment")
    op.execute("DROP TABLE IF EXISTS article_entities")
    op.execute("DROP TABLE IF EXISTS articles")
