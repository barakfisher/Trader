"""`upcoming_listings`: companies on their way to an IPO, from SEC filings (D404-D408).

Anthropic listed on 2026-11-19 with a public S-1 on EDGAR since 10-26, and
nothing in the app knew. A daily run, `upcoming_ipos`, reads EDGAR and writes:

- **`upcoming_listings`**, one row per registrant (its CIK), tracked or
  excluded. A tracked one carries its stage and the date of each step
  (`app/filings/upcoming.py` names them); an excluded one only its name and why
  (`blank_check`, `reporting_company`, `fund`), so it is never fetched again.
  Ticker and exchange are SEC's, once it lists them.
- **`upcoming_listing_filings`**, the filings behind a tracked company's
  stages: accession, form, date and the URL a person reads it at.

**Dates and stages only** (D405): no price range, share count or money column.
**No `user_id`** (D406): the rows are public filings about the market, the
installation's like `instruments` and `articles`; no account owns or
changes them, and guideline 5 is for user-owned tables.

- **`runs.kind`** gains `upcoming_ipos`.

Downgrade drops both tables and the runs of the new kind, which are
bookkeeping; a later upgrade rebuilds the rows from EDGAR within a run.

Revision ID: 0089_upcoming_listings
Revises: 0088_listed_membership
"""

from alembic import op

revision = "0089_upcoming_listings"
down_revision = "0088_listed_membership"
branch_labels = None
depends_on = None

#: `app/filings/upcoming.py` STAGES, FILING_STAGES, EXCLUSIONS and STAGE_OF_FORM.
STAGES = (
    "confidential",
    "filed",
    "amended",
    "registered",
    "priced",
    "withdrawn",
    "listed",
)
FILING_STAGES = STAGES[:-1]
EXCLUSIONS = ("blank_check", "reporting_company", "fund")
FORMS = ("DRS", "DRS/A", "S-1", "S-1/A", "F-1", "F-1/A", "8-A12B", "8-A12B/A", "424B4", "RW")

#: The run kinds before this migration (last changed by 0088).
PREVIOUS_KINDS = (
    "snapshot",
    "portfolio_scan",
    "topic_scan",
    "daily_digest",
    "backfill",
    "proposal_sweep",
    "instrument_metadata",
    "news_collect",
    "topic_discovery",
    "universe_rescreen",
    "agent_scans",
    "agent_scan",
    "research",
    "session_sweep",
    "auth_sweep",
    "account_erase",
    "open_approvals",
    "new_listings",
)
KINDS = (*PREVIOUS_KINDS, "upcoming_ipos")


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _kinds(values: tuple[str, ...]) -> None:
    op.execute("ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_kind_check")
    op.execute(
        f"ALTER TABLE runs ADD CONSTRAINT runs_kind_check CHECK (kind IN ({_sql_list(values)}))"
    )


def upgrade() -> None:
    op.execute(
        f"""
        CREATE TABLE upcoming_listings (
            cik             text PRIMARY KEY CHECK (cik ~ '^[0-9]{{10}}$'),
            company_name    text NOT NULL CHECK (length(company_name) <= 300),
            excluded        text CHECK (excluded IN ({_sql_list(EXCLUSIONS)})),
            ticker          text CHECK (length(ticker) <= 20),
            exchange        text CHECK (length(exchange) <= 40),
            stage           text CHECK (stage IN ({_sql_list(STAGES)})),
            stage_on        date,
            confidential_on date,
            filed_on        date,
            amended_on      date,
            registered_on   date,
            priced_on       date,
            withdrawn_on    date,
            listed_on       date,
            created_at      timestamptz NOT NULL DEFAULT now(),
            updated_at      timestamptz NOT NULL DEFAULT now(),
            -- Tracked (a stage and its date) or excluded (a reason), never both.
            CONSTRAINT upcoming_listings_tracked_or_excluded CHECK (
                (excluded IS NULL AND stage IS NOT NULL AND stage_on IS NOT NULL)
                OR (excluded IS NOT NULL AND stage IS NULL AND stage_on IS NULL)
            ),
            CONSTRAINT upcoming_listings_listed_has_date
                CHECK ((stage = 'listed') = (listed_on IS NOT NULL))
        )
        """
    )
    op.execute(
        "CREATE INDEX upcoming_listings_recent_idx ON upcoming_listings (stage_on DESC) "
        "WHERE excluded IS NULL"
    )
    op.execute(
        f"""
        CREATE TABLE upcoming_listing_filings (
            accession  text PRIMARY KEY CHECK (accession ~ '^[0-9]{{10}}-[0-9]{{2}}-[0-9]{{6}}$'),
            cik        text NOT NULL REFERENCES upcoming_listings(cik) ON DELETE CASCADE,
            form       text NOT NULL CHECK (form IN ({_sql_list(FORMS)})),
            stage      text NOT NULL CHECK (stage IN ({_sql_list(FILING_STAGES)})),
            filed_on   date NOT NULL,
            url        text NOT NULL CHECK (url LIKE 'https://www.sec.gov/%'),
            created_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        "CREATE INDEX upcoming_listing_filings_cik_idx "
        "ON upcoming_listing_filings (cik, filed_on DESC)"
    )
    _kinds(KINDS)


def downgrade() -> None:
    op.execute("DELETE FROM runs WHERE kind = 'upcoming_ipos'")
    _kinds(PREVIOUS_KINDS)
    op.execute("DROP TABLE upcoming_listing_filings")
    op.execute("DROP TABLE upcoming_listings")
