"""Which registrants are tracked, and what stage each is at (no database).

The SQL - idempotence, `listed`, the read model - is
`tests/integration/test_upcoming_listings_sql.py`'s.
"""

from __future__ import annotations

import importlib.util
import json
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest

from app.filings.base import CompanyFilings, Filing
from app.filings.edgar import parse_submissions
from app.filings.fixture import FIXTURE_FILENAME
from app.filings.upcoming import (
    BLANK_CHECK_SIC,
    COMMODITY_TRUST_SIC,
    EXCLUSIONS,
    FILING_STAGES,
    STAGE_OF_FORM,
    STAGES,
    exclusion,
    progress,
)

SERVICE = Path(__file__).resolve().parents[1]
FIXTURES = SERVICE.parents[1] / "data" / "fixtures"
SEEN = date(2026, 11, 19)


def _fixture(cik: str) -> CompanyFilings:
    data = json.loads((FIXTURES / FIXTURE_FILENAME).read_text())
    return parse_submissions(data["companies"][cik])


def _filing(form: str, on: date) -> Filing:
    return Filing(accession=f"x-{form}-{on}", form=form, filed_on=on, url="https://www.sec.gov/x")


FRESH = CompanyFilings(
    cik="0000000001",
    name="Fresh Robotics, Inc.",
    sic="3569",
    tickers=(),
    exchanges=(),
    filings=(_filing("S-1", date(2026, 11, 1)),),
)


def test_anthropic_is_tracked_and_priced_with_each_step_dated() -> None:
    anthropic = _fixture("0002130357")
    assert exclusion(anthropic, first_seen_on=SEEN) is None
    state = progress(anthropic.filings, seen_on=SEEN)
    assert state.stage == "priced"
    assert state.stage_on == date(2026, 11, 19)
    assert state.confidential_on == date(2026, 6, 1)
    assert state.filed_on == date(2026, 10, 26)
    assert state.amended_on == date(2026, 11, 17)
    assert state.registered_on == date(2026, 11, 17)
    assert state.priced_on == date(2026, 11, 19)
    assert state.withdrawn_on is None


@pytest.mark.parametrize(
    ("cik", "reason"),
    [("0009000001", "blank_check"), ("0009000002", "reporting_company"), ("0009000003", "fund")],
)
def test_the_fixtures_other_registrants_are_excluded(cik: str, reason: str) -> None:
    assert exclusion(_fixture(cik), first_seen_on=SEEN) == reason


def test_a_blank_check_by_its_industry_code_or_its_name() -> None:
    assert exclusion(replace(FRESH, sic=BLANK_CHECK_SIC), first_seen_on=SEEN) == "blank_check"
    named = replace(FRESH, name="Churchill Growth Acquisition Corp. XIV", sic="")
    assert exclusion(named, first_seen_on=SEEN) == "blank_check"


def test_a_fund_by_its_industry_code_or_its_name() -> None:
    assert exclusion(replace(FRESH, sic=COMMODITY_TRUST_SIC), first_seen_on=SEEN) == "fund"
    assert exclusion(replace(FRESH, name="Bitwise Zcash ETF", sic=""), first_seen_on=SEEN) == "fund"


def test_a_company_that_reported_before_it_registered_is_not_an_ipo() -> None:
    reporter = replace(FRESH, filings=(*FRESH.filings, _filing("10-Q", date(2026, 8, 1))))
    assert exclusion(reporter, first_seen_on=SEEN) == "reporting_company"
    assert (
        exclusion(replace(FRESH, has_older_filings=True), first_seen_on=SEEN) == "reporting_company"
    )


def test_a_report_after_it_was_first_seen_does_not_exclude() -> None:
    # A company that listed and then filed its first 10-Q is still the IPO it was.
    later = replace(FRESH, filings=(*FRESH.filings, _filing("10-Q", date(2026, 12, 1))))
    assert exclusion(later, first_seen_on=SEEN) is None


def test_a_follow_on_of_a_company_public_for_years_is_not_an_ipo() -> None:
    # Its old IPO S-1 comes before its reports; the new S-1 is what was seen.
    public = replace(
        FRESH,
        filings=(
            _filing("S-1", date(2021, 3, 1)),
            _filing("10-K", date(2026, 3, 1)),
            _filing("S-1", date(2026, 11, 1)),
        ),
    )
    assert exclusion(public, first_seen_on=date(2026, 11, 1)) == "reporting_company"


def test_a_name_with_trust_or_capital_is_not_excluded_by_it() -> None:
    assert exclusion(replace(FRESH, name="Janus Living Realty Trust"), first_seen_on=SEEN) is None


def test_the_latest_filing_sets_the_stage_and_a_later_stage_wins_a_tie() -> None:
    same_day = [_filing("S-1/A", date(2026, 11, 17)), _filing("8-A12B", date(2026, 11, 17))]
    assert progress(same_day, seen_on=SEEN).stage == "registered"
    refiled = [_filing("RW", date(2026, 9, 1)), _filing("S-1", date(2026, 10, 1))]
    state = progress(refiled, seen_on=SEEN)
    assert (state.stage, state.withdrawn_on) == ("filed", date(2026, 9, 1))


def test_forms_without_a_stage_are_ignored() -> None:
    state = progress(
        [_filing("S-1", date(2026, 10, 1)), _filing("FWP", date(2026, 11, 1))], seen_on=SEEN
    )
    assert (state.stage, state.stage_on) == ("filed", date(2026, 10, 1))
    assert [f.form for f in state.filings] == ["S-1"]


def test_a_history_behind_the_search_is_filed_on_the_hits_date() -> None:
    state = progress([], seen_on=SEEN)
    assert (state.stage, state.stage_on) == ("filed", SEEN)


def test_the_migration_enumerates_what_the_module_writes() -> None:
    path = SERVICE / "alembic" / "versions" / "0089_upcoming_listings.py"
    spec = importlib.util.spec_from_file_location("m0089", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.STAGES == STAGES
    assert migration.FILING_STAGES == FILING_STAGES
    assert migration.EXCLUSIONS == EXCLUSIONS
    assert set(migration.FORMS) == set(STAGE_OF_FORM)
    assert set(STAGE_OF_FORM.values()) == set(FILING_STAGES)
