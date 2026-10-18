"""`universe_taxonomy`: the sectors, industries and ETF categories the universe holds (D164).

The agent template creator's "Sectors & industries" picker reads this table and
nothing else, so no keystroke ever reaches Yahoo. It is derived, not entered:
`app/universe/taxonomy.py` rewrites it from `instrument_profiles` inside every
universe load - the startup loader's and the rescreen's - in the same
transaction, so the picker never offers a classification the profiles have
stopped holding.

- **Built from the universe, not from Yahoo's full list** (D164). Every row has
  screened instruments behind it, and `instruments` says how many, so an agent
  restricted to a selection can never be restricted to nothing.
- **Two kinds.** `industry` rows come from equities and always name their
  sector: Yahoo files each industry under exactly one. `etf_category` rows come
  from ETFs, which carry a Morningstar-style category instead of a sector;
  `sector` is the one a committed map assigns (`ETF_CATEGORY_SECTORS`), or null
  for a category that is not about a sector ("Large Blend", "Muni National
  Long"). Sectors themselves are not rows: they are the distinct `sector`
  values, and a sector's count is the sum of its rows.
- **No `user_id`.** The universe is the installation's, like
  `instrument_profiles`; nothing here belongs to an account (guideline 5 covers
  user-owned tables).
- **Empty after this migration.** The startup loader reloads the newest
  snapshot on every stack start, and that load fills the table; a migration
  cannot apply the category map without importing application code.
- **A reload that changes nothing writes nothing**, as DB2 made true of the
  profiles: rows are upserted only where they differ and deleted only where the
  universe stopped holding them, so the loader that runs on every start leaves
  every row version alone.

Revision ID: 0056_universe_taxonomy
Revises: 0055_articles_fetched_idx
"""

from alembic import op

revision = "0056_universe_taxonomy"
down_revision = "0055_articles_fetched_idx"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE universe_taxonomy (
            kind         text NOT NULL CHECK (kind IN ('industry', 'etf_category')),
            -- The industry's or category's name, as Yahoo spells it.
            name         text NOT NULL CHECK (length(btrim(name)) > 0),
            sector       text CHECK (sector IS NULL OR length(btrim(sector)) > 0),
            -- Screened profiles with this classification when the table was built.
            instruments  integer NOT NULL CHECK (instruments > 0),
            -- When this row last changed. A reload that changes nothing writes nothing.
            updated_at   timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (kind, name),
            CONSTRAINT universe_taxonomy_industry_has_sector
                CHECK (kind <> 'industry' OR sector IS NOT NULL)
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE universe_taxonomy")
