"""Upcoming IPOs from SEC filings: who is going public, and how far along (migration 0089).

On 2026-11-19 Anthropic listed as ANT and nothing in the app knew it was
coming, although its public S-1 had been on EDGAR for 24 days. The daily
new-listings screen (D402) admits a listing once it trades; this run knows of
it before, from the filings a company makes on the way:

    DRS        confidential  a draft, public only once SEC releases it
    S-1, F-1   filed         the public registration statement
    .../A      amended       each revision of it
    8-A12B     registered    the class of shares registered on an exchange
    424B4      priced        the final prospectus, the day before trading
    RW         withdrawn     the registration withdrawn
               listed        the ticker became a universe member (`listed`
                             or `screened`, D402; D408)

**Dates and stages only** (D405). No price range, share count or proceeds:
they sit in prospectus prose, and a figure read out of prose is the unsourced
number guideline 7 bars. No model runs here.

**How a run finds them** (D404, D407; measured 2026-11-19 over a month of filings).
Two searches over the last `LOOKBACK_DAYS`, by form: the registration forms
(`DISCOVERY_FORMS`) find new registrants; the later forms (`EVENT_FORMS`) only
move a company already tracked, because most 8-A12B filers are funds and
companies listed for years. A registrant seen for the first time has its
history fetched once and is either tracked or excluded for good:

  * `blank_check` - SIC 6770, or "Acquisition Corp" in its name: a SPAC, a
    shell that raises cash and buys a company later (17 of 154 that month);
  * `reporting_company` - it filed a 10-K, 10-Q, 20-F or 40-F before the
    earliest filing of it the searches found, or has more history than one
    page holds: a follow-on or a resale, not an IPO (69 of 154);
  * `fund` - "ETF" or "Fund" in its name, or SIC 6221, under which the
    commodity and crypto trusts register (7 of 154).

What is left (61 of 154, about 15 a week) is still noisy: many are small
self-underwritten companies that will never list on an exchange. The stage is
the signal - 9 of those 61 reached `registered` or `priced` that month, all
real IPOs - so the read model returns it, and the reader decides how much to
show.

**Idempotent.** An excluded registrant is never fetched again; a tracked one
only when a search shows a filing of it that is not stored yet. A re-run with
nothing new makes the two searches and writes nothing.

**At most `MAX_COMPANIES_PER_RUN` histories a run**, tracked companies first;
the rest are the next run's, which still sees them inside the lookback.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from app.core.logging import get_logger
from app.filings.base import CompanyFilings, Filing, FilingsProvider, FilingsProviderError

log = get_logger("filings.upcoming")

#: Days of filings each run searches. Covers an outage of a month, and an S-1
#: made before the first run: Anthropic's came 24 days before it listed.
LOOKBACK_DAYS = 30
#: Forms that put a registrant on the list (EDGAR's search matches amendments).
DISCOVERY_FORMS = ("S-1", "F-1", "DRS")
#: Forms that only move a registrant already tracked.
EVENT_FORMS = ("8-A12B", "424B4", "RW")
#: Company histories one run fetches; at SEC's pace, about 15 seconds.
MAX_COMPANIES_PER_RUN = 120

#: Each stored form and the stage it marks.
STAGE_OF_FORM = {
    "DRS": "confidential",
    "DRS/A": "confidential",
    "S-1": "filed",
    "F-1": "filed",
    "S-1/A": "amended",
    "F-1/A": "amended",
    "8-A12B": "registered",
    "8-A12B/A": "registered",
    "424B4": "priced",
    "RW": "withdrawn",
}
#: Stages in the order a company moves through them; a later one wins a tie of dates.
FILING_STAGES = ("confidential", "filed", "amended", "registered", "priced", "withdrawn")
#: Every value `upcoming_listings.stage` may hold (migration 0089).
STAGES = (*FILING_STAGES, "listed")
#: Stages of a company that is on its way to trading.
PENDING_STAGES = ("filed", "amended", "registered", "priced")
#: Why a registrant is not tracked (migration 0089).
EXCLUSIONS = ("blank_check", "reporting_company", "fund")

BLANK_CHECK_SIC = "6770"
COMMODITY_TRUST_SIC = "6221"
_BLANK_CHECK_NAME = re.compile(r"\bacquisition\s+corp", re.IGNORECASE)
_FUND_NAME = re.compile(r"\b(etf|fund)\b", re.IGNORECASE)
#: Periodic reports: a company that files them is public already.
REPORT_FORMS = frozenset({"10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A", "40-F", "40-F/A"})

#: The read model's defaults: what the agents' briefing will show.
RECENT_DAYS = 30
MAX_RECENT = 25


def exclusion(company: CompanyFilings, *, first_seen_on: date) -> str | None:
    """Why this registrant is not an IPO to track, or None when it may be one.

    `first_seen_on` is the date of its earliest filing the searches found. A
    periodic report before it means the company is public already, whatever
    it registered years ago: a company that went public in 2021 and files an
    S-1 for a follow-on has its 2021 S-1 first in its history, so "a report
    before its first registration" would track it (reAlpha, AIRE, measured).
    """
    if company.sic == BLANK_CHECK_SIC or _BLANK_CHECK_NAME.search(company.name):
        return "blank_check"
    if company.sic == COMMODITY_TRUST_SIC or _FUND_NAME.search(company.name):
        return "fund"
    if company.has_older_filings:
        return "reporting_company"
    if any(f.form in REPORT_FORMS and f.filed_on < first_seen_on for f in company.filings):
        return "reporting_company"
    return None


@dataclass(frozen=True, slots=True)
class Progress:
    """A tracked company's stage and the date of each step, from its filings."""

    stage: str
    stage_on: date
    confidential_on: date | None
    filed_on: date | None
    amended_on: date | None
    registered_on: date | None
    priced_on: date | None
    withdrawn_on: date | None
    filings: tuple[Filing, ...]


def progress(filings: Sequence[Filing], *, seen_on: date) -> Progress:
    """The stage a company is at: the furthest it has reached since its last withdrawal.

    A stage never goes backwards (D405): an S-1/A filed after the 8-A12B is a
    last revision of a registered company, and a DRS/A SEC releases after the
    public S-1 is history. A withdrawal is the stage only while it is the
    latest filing; a registration after it starts over. The stage's date is
    that of its latest filing. First dates for the steps that happen once, the
    latest for amendments and withdrawals, which repeat. A company whose
    history does not show the filing the search found yet is `filed` on the
    hit's date until it does.
    """
    staged = tuple(f for f in filings if f.form in STAGE_OF_FORM)

    def rank(f: Filing) -> int:
        return FILING_STAGES.index(STAGE_OF_FORM[f.form])

    def dates(stage: str) -> list[date]:
        return [f.filed_on for f in staged if STAGE_OF_FORM[f.form] == stage]

    withdrawals = [f.filed_on for f in staged if STAGE_OF_FORM[f.form] == "withdrawn"]
    last_withdrawal = max(withdrawals, default=None)
    since = [
        f
        for f in staged
        if STAGE_OF_FORM[f.form] != "withdrawn"
        and (last_withdrawal is None or f.filed_on > last_withdrawal)
    ]
    if since:
        furthest = max(since, key=lambda f: (rank(f), f.filed_on))
        stage, stage_on = STAGE_OF_FORM[furthest.form], furthest.filed_on
    elif last_withdrawal is not None:
        stage, stage_on = "withdrawn", last_withdrawal
    else:
        stage, stage_on = "filed", seen_on
    return Progress(
        stage=stage,
        stage_on=stage_on,
        confidential_on=min(dates("confidential"), default=None),
        filed_on=min(dates("filed"), default=None),
        amended_on=max(dates("amended"), default=None),
        registered_on=min(dates("registered"), default=None),
        priced_on=min(dates("priced"), default=None),
        withdrawn_on=max(dates("withdrawn"), default=None),
        filings=staged,
    )


@dataclass(slots=True)
class UpcomingReport:
    #: Filings the two searches returned.
    searched: int = 0
    #: Registrants seen for the first time, by what became of them.
    tracked: list[str] = field(default_factory=list)
    excluded: Counter[str] = field(default_factory=Counter)
    #: Tracked companies whose stage or dates changed, as "NAME: stage".
    advanced: list[str] = field(default_factory=list)
    #: Tickers that became universe members in this run.
    listed: list[str] = field(default_factory=list)
    #: Registrants whose history could not be fetched; asked again next run.
    failed: list[str] = field(default_factory=list)
    #: Registrants left for the next run by the cap.
    deferred: int = 0


async def track_upcoming_listings(
    *, engine: Engine, provider: FilingsProvider, today: date
) -> UpcomingReport:
    """One run: search, fetch what is new, write what changed, mark what listed.

    A failed search raises `FilingsProviderError` and writes nothing; the run
    is retried. A failed history is reported and asked again next run.
    """
    start = today - timedelta(days=LOOKBACK_DAYS)
    discovered = await provider.search(DISCOVERY_FORMS, start, today)
    events = await provider.search(EVENT_FORMS, start, today)
    report = UpcomingReport(searched=len(discovered) + len(events))

    with engine.connect() as connection:
        known = _known(connection, {hit.cik for hit in (*discovered, *events)})
        stored = _stored_accessions(connection, [cik for cik, k in known.items() if k.tracked])
        tickerless = _awaiting_ticker(connection, since=start)
        known.update(_known(connection, {cik for cik, _ in tickerless}))

    latest_hit: dict[str, date] = {}
    first_hit: dict[str, date] = {}
    unstored: set[str] = set()
    for hit in (*discovered, *events):
        entry = known.get(hit.cik)
        if entry is None and hit.form.split("/", 1)[0] not in DISCOVERY_FORMS:
            continue  # an 8-A12B, 424B4 or RW of a registrant nobody tracks
        if entry is not None and not entry.tracked:
            continue  # excluded for good, or listed already
        if entry is not None and (hit.accession in stored or hit.form not in STAGE_OF_FORM):
            # Stored already, or a form the search matched that is never stored
            # (S-1MEF, RW WD): fetching for it would repeat every run.
            continue
        unstored.add(hit.cik)
        latest_hit[hit.cik] = max(latest_hit.get(hit.cik, hit.filed_on), hit.filed_on)
        first_hit[hit.cik] = min(first_hit.get(hit.cik, hit.filed_on), hit.filed_on)

    # A registered or priced company SEC has given no ticker yet is asked again
    # each run inside the lookback: after its 424B4 it files nothing the
    # searches see, and without a ticker it could never be marked listed.
    for cik, since in tickerless:
        if cik not in unstored:
            unstored.add(cik)
            latest_hit[cik] = first_hit[cik] = since

    # Tracked companies first, then new registrants, newest first.
    order = sorted(unstored, key=lambda cik: (cik not in known, -latest_hit[cik].toordinal(), cik))
    fetch, report.deferred = (
        order[:MAX_COMPANIES_PER_RUN],
        max(0, len(order) - MAX_COMPANIES_PER_RUN),
    )

    for cik in fetch:
        try:
            company = await provider.company(cik)
        except FilingsProviderError as error:
            if error.refused:
                raise  # SEC refuses this client: every history would fail the same way
            log.warning("filings.upcoming.company_failed", cik=cik, error=str(error))
            report.failed.append(cik)
            continue
        new = cik not in known
        reason = exclusion(company, first_seen_on=first_hit[cik]) if new else None
        with engine.begin() as connection:
            if reason is not None:
                _write_excluded(connection, company, reason)
                report.excluded[reason] += 1
                continue
            state = progress(company.filings, seen_on=latest_hit[cik])
            changed = _write_tracked(connection, company, state)
        if new:
            report.tracked.append(company.name)
        if changed:
            report.advanced.append(f"{company.name}: {state.stage}")

    with engine.begin() as connection:
        report.listed = mark_listed(connection, today=today)
    log.info(
        "filings.upcoming.done",
        searched=report.searched,
        tracked=len(report.tracked),
        excluded=dict(report.excluded),
        advanced=len(report.advanced),
        listed=report.listed,
        failed=len(report.failed),
        deferred=report.deferred,
    )
    return report


@dataclass(frozen=True, slots=True)
class _Known:
    excluded: str | None
    stage: str | None

    @property
    def tracked(self) -> bool:
        """Still followed: not excluded, and not trading yet."""
        return self.excluded is None and self.stage != "listed"


def _known(connection: Connection, ciks: set[str]) -> dict[str, _Known]:
    if not ciks:
        return {}
    rows = connection.execute(
        text("SELECT cik, excluded, stage FROM upcoming_listings WHERE cik = ANY(:ciks)"),
        {"ciks": sorted(ciks)},
    )
    return {row.cik: _Known(row.excluded, row.stage) for row in rows}


def _awaiting_ticker(connection: Connection, *, since: date) -> list[tuple[str, date]]:
    rows = connection.execute(
        text(
            """
            SELECT cik, stage_on FROM upcoming_listings
             WHERE excluded IS NULL AND ticker IS NULL
               AND stage IN ('registered', 'priced') AND stage_on >= :since
            """
        ),
        {"since": since},
    )
    return [(row.cik, row.stage_on) for row in rows]


def _stored_accessions(connection: Connection, ciks: list[str]) -> set[str]:
    if not ciks:
        return set()
    return set(
        connection.execute(
            text("SELECT accession FROM upcoming_listing_filings WHERE cik = ANY(:ciks)"),
            {"ciks": ciks},
        ).scalars()
    )


def _write_excluded(connection: Connection, company: CompanyFilings, reason: str) -> None:
    connection.execute(
        text(
            """
            INSERT INTO upcoming_listings (cik, company_name, excluded)
            VALUES (:cik, :name, :excluded)
            ON CONFLICT (cik) DO NOTHING
            """
        ),
        {"cik": company.cik, "name": company.name, "excluded": reason},
    )


def _write_tracked(connection: Connection, company: CompanyFilings, state: Progress) -> bool:
    """Insert or update one tracked company; True when anything about it changed."""
    values = {
        "cik": company.cik,
        "name": company.name,
        "ticker": company.tickers[0].upper() if company.tickers else None,
        # The exchange that goes with the ticker kept, when SEC names one.
        "exchange": company.exchanges[0] if company.exchanges else None,
        "stage": state.stage,
        "stage_on": state.stage_on,
        "confidential_on": state.confidential_on,
        "filed_on": state.filed_on,
        "amended_on": state.amended_on,
        "registered_on": state.registered_on,
        "priced_on": state.priced_on,
        "withdrawn_on": state.withdrawn_on,
    }
    row = connection.execute(
        text(
            """
            INSERT INTO upcoming_listings (
                cik, company_name, ticker, exchange, stage, stage_on, confidential_on,
                filed_on, amended_on, registered_on, priced_on, withdrawn_on
            ) VALUES (
                :cik, :name, :ticker, :exchange, :stage, :stage_on, :confidential_on,
                :filed_on, :amended_on, :registered_on, :priced_on, :withdrawn_on
            )
            ON CONFLICT (cik) DO UPDATE
               SET company_name    = EXCLUDED.company_name,
                   ticker          = COALESCE(EXCLUDED.ticker, upcoming_listings.ticker),
                   exchange        = COALESCE(EXCLUDED.exchange, upcoming_listings.exchange),
                   stage           = EXCLUDED.stage,
                   stage_on        = EXCLUDED.stage_on,
                   confidential_on = EXCLUDED.confidential_on,
                   filed_on        = EXCLUDED.filed_on,
                   amended_on      = EXCLUDED.amended_on,
                   registered_on   = EXCLUDED.registered_on,
                   priced_on       = EXCLUDED.priced_on,
                   withdrawn_on    = EXCLUDED.withdrawn_on,
                   updated_at      = now()
             WHERE upcoming_listings.excluded IS NULL
               AND upcoming_listings.stage <> 'listed'
               AND (upcoming_listings.company_name, upcoming_listings.ticker,
                    upcoming_listings.exchange, upcoming_listings.stage,
                    upcoming_listings.stage_on, upcoming_listings.confidential_on,
                    upcoming_listings.filed_on, upcoming_listings.amended_on,
                    upcoming_listings.registered_on, upcoming_listings.priced_on,
                    upcoming_listings.withdrawn_on)
                   IS DISTINCT FROM
                   (EXCLUDED.company_name, COALESCE(EXCLUDED.ticker, upcoming_listings.ticker),
                    COALESCE(EXCLUDED.exchange, upcoming_listings.exchange), EXCLUDED.stage,
                    EXCLUDED.stage_on, EXCLUDED.confidential_on,
                    EXCLUDED.filed_on, EXCLUDED.amended_on,
                    EXCLUDED.registered_on, EXCLUDED.priced_on,
                    EXCLUDED.withdrawn_on)
            RETURNING cik
            """
        ),
        values,
    ).first()
    if state.filings:
        connection.execute(
            text(
                """
                INSERT INTO upcoming_listing_filings (accession, cik, form, stage, filed_on, url)
                VALUES (:accession, :cik, :form, :stage, :filed_on, :url)
                ON CONFLICT (accession) DO NOTHING
                """
            ),
            [
                {
                    "accession": f.accession,
                    "cik": company.cik,
                    "form": f.form,
                    "stage": STAGE_OF_FORM[f.form],
                    "filed_on": f.filed_on,
                    "url": f.url,
                }
                for f in state.filings
            ],
        )
    return row is not None


#: A tracked ticker is trading when it is a universe member admitted after the
#: company's latest filing: `listed` by the daily screen, or `screened` by a
#: snapshot sized on or after that filing. An older `screened` member under the
#: same ticker is another company that used it, not this one - and a snapshot
#: sized between a company's first draft and its pricing cannot hold it either.
_MEMBER_SINCE_FILING = """
    EXISTS (
        SELECT 1 FROM instruments i JOIN instrument_profiles p ON p.instrument_id = i.id
         WHERE i.symbol = u.ticker
           AND (p.membership = 'listed'
                OR (p.membership = 'screened'
                    AND p.size_as_of::date >= u.stage_on))
    )
"""


def mark_listed(connection: Connection, *, today: date) -> list[str]:
    """Move every tracked company whose ticker became a member to `listed`; their tickers.

    Not a withdrawn one: a withdrawn company that is trading under its ticker
    is more likely another company than this one.
    """
    return sorted(
        connection.execute(
            text(
                f"""
                UPDATE upcoming_listings u
                   SET stage = 'listed', stage_on = :today, listed_on = :today,
                       updated_at = now()
                 WHERE u.excluded IS NULL
                   AND u.stage NOT IN ('listed', 'withdrawn')
                   AND u.ticker IS NOT NULL
                   AND {_MEMBER_SINCE_FILING}
             RETURNING u.ticker
                """
            ),
            {"today": today},
        ).scalars()
    )


@dataclass(frozen=True, slots=True)
class UpcomingListing:
    """One company on its way to trading, as the agents' briefing will read it."""

    cik: str
    company_name: str
    ticker: str | None
    exchange: str | None
    stage: str
    stage_on: date
    filed_on: date | None
    registered_on: date | None
    priced_on: date | None
    #: The filing that put it at this stage.
    url: str | None


def recent_upcoming_listings(
    connection: Connection,
    *,
    today: date,
    days: int = RECENT_DAYS,
    limit: int = MAX_RECENT,
) -> list[UpcomingListing]:
    """Companies at a pending stage reached in the last `days`, newest first, at most `limit`.

    A ticker already trading as a member is left out even before the next run
    marks it `listed`: the new-listings screen may admit it in between.
    """
    rows = connection.execute(
        text(
            f"""
            SELECT u.cik, u.company_name, u.ticker, u.exchange, u.stage, u.stage_on,
                   u.filed_on, u.registered_on, u.priced_on,
                   (SELECT f.url FROM upcoming_listing_filings f
                     WHERE f.cik = u.cik AND f.stage = u.stage
                     ORDER BY f.filed_on DESC, f.accession DESC LIMIT 1) AS url
              FROM upcoming_listings u
             WHERE u.excluded IS NULL
               AND u.stage = ANY(:stages)
               AND u.stage_on >= :since
               AND NOT (u.ticker IS NOT NULL AND {_MEMBER_SINCE_FILING})
             ORDER BY u.stage_on DESC, u.company_name
             LIMIT :limit
            """
        ),
        {"stages": list(PENDING_STAGES), "since": today - timedelta(days=days), "limit": limit},
    )
    return [UpcomingListing(**row._mapping) for row in rows]
