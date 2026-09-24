"""What each instrument in the topic universe does, and its vector (M5).

A topic resolves to instruments by what the business *does*, not by the sector
label on it: measured on the M5 eval, Yahoo files NuScale under "Specialty
Industrial Machinery", Palantir and Block under "Software - Infrastructure" and
IBM under "IT Services", and a sector match would miss all of them. The business
summary names reactors, defence analytics, payments and quantum hardware. So
this table holds that summary and an embedding of it.

**A table of its own, not a third namespace in `kb_chunks`.** That was the
obvious reuse and it would have broken `/ask` silently. pgvector's HNSW scan
returns at most `hnsw.ef_search` (default 40) candidates and applies the WHERE
clause *afterwards* - iterative scans exist in 0.8 but are off by default. With
~3,600 instrument vectors beside 36 concept chunks in one index, the 40 nearest
rows to a concept question can easily all be instruments, and the namespace
filter then leaves `/ask` with nothing: no error, just an emptier answer. A
separate index per population makes that impossible rather than unlikely.

**The description's licence is recorded because it is not ours.** It is Yahoo's
text, so it is fetched per installation and never committed (see
`app/universe/snapshot.py`); the committed snapshot holds membership and facts
only. `license` is NOT NULL with no default for the same reason as on
`kb_documents`: an unexamined source must not get in by saying nothing.

**The description is stored verbatim and the text embedded is stored beside
it.** Every Yahoo summary opens with the company's name, and an embedding
matches name tokens: "fast food" admitted Fastenal, "mount everest" found
Everest Group. The embedded text replaces the instrument's own name; the
verbatim text is what a rationale quotes.

**Size is stored with its date and is not part of the embedding.** Market cap
moves daily and a description does not; a filter on size is a predicate here,
beside the vector, so a future "minimum market cap" setting needs no re-embed.
Money is integer minor units with an explicit currency (guideline 3); an ETF has
net assets and no market cap, and a missing figure is null, never zero.

**No `user_id`**: this is reference data about listed instruments, like
`instruments` and `quotes`, and is shared by every user.

Revision ID: 0015_instrument_profiles
Revises: 0014_intent_revocation
"""

from alembic import op

revision = "0015_instrument_profiles"
down_revision = "0014_intent_revocation"
branch_labels = None
depends_on = None

#: Same model, same width as `kb_chunks.embedding` (0013), so one embedder
#: serves both and a topic query is comparable with a profile.
EMBEDDING_DIMENSION = 1536


def upgrade() -> None:
    op.execute(
        f"""
        CREATE TABLE instrument_profiles (
            instrument_id     uuid PRIMARY KEY REFERENCES instruments(id) ON DELETE CASCADE,

            -- Verbatim, because rationales quote it.
            description       text NOT NULL,
            -- What is embedded: the description with the instrument's own name
            -- replaced (app/universe/matching_text.py). Stored rather than
            -- recomputed so the vector and the hash are provably of one text.
            matching_text     text NOT NULL,
            source            text NOT NULL,
            license           text NOT NULL,
            -- Of the matching text and the rule version that produced it. A
            -- re-ingest that finds the same hash writes nothing, so the
            -- embedding survives and nothing is paid twice.
            content_hash      text NOT NULL,

            sector            text,
            industry          text,
            category          text,

            market_cap_minor  bigint CHECK (market_cap_minor > 0),
            net_assets_minor  bigint CHECK (net_assets_minor > 0),
            size_currency     text,
            -- When the universe snapshot these facts came from was taken.
            size_as_of        timestamptz NOT NULL,

            text_search       tsvector
                              GENERATED ALWAYS AS (to_tsvector('english', matching_text)) STORED,

            embedding         vector({EMBEDDING_DIMENSION}),
            embedding_model   text,
            CONSTRAINT instrument_profiles_embedding_model_pair
                CHECK ((embedding IS NULL) = (embedding_model IS NULL)),

            updated_at        timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        "CREATE INDEX instrument_profiles_search_idx ON instrument_profiles USING GIN (text_search)"
    )
    op.execute(
        """
        CREATE INDEX instrument_profiles_embedding_idx
            ON instrument_profiles USING hnsw (embedding vector_cosine_ops)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE instrument_profiles")
