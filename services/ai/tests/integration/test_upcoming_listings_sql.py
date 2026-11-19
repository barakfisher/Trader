"""The daily upcoming-IPO run through the real SQL (migration 0089).

EDGAR is the one thing replaced: the fixture provider answers in SEC's shapes,
with Anthropic's real 2026 filings and three invented registrants, one per
exclusion. Pinned: what a first run tracks and excludes; that a re-run asks
for no history and writes nothing; that a new filing moves a company; when a
ticker counts as listed; and what the read model returns.
"""

from __future__ import annotations

import copy
import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.filings.base import CompanyFilings, FilingsProviderError
from app.filings.fixture import FIXTURE_FILENAME, FixtureFilingsProvider
from app.filings.upcoming import (
    MAX_COMPANIES_PER_RUN,
    PENDING_STAGES,
    RECENT_DAYS,
    recent_upcoming_listings,
    track_upcoming_listings,
)

FIXTURES = Path(__file__).resolve().parents[4] / "data" / "fixtures"
ANTHROPIC = "0002130357"
#: The fixture's listing day, inside its 30-day window.
LISTING_DAY = date(2026, 11, 19)


def _data() -> dict[str, Any]:
    return json.loads((FIXTURES / FIXTURE_FILENAME).read_text())


class CountingProvider(FixtureFilingsProvider):
    def __init__(self, data: dict[str, Any]) -> None:
        super().__init__(data=data)
        self.asked: list[str] = []

    async def company(self, cik: str) -> CompanyFilings:
        self.asked.append(cik)
        return await super().company(cik)


def _before_pricing(data: dict[str, Any]) -> dict[str, Any]:
    """The fixture as it stood on 11-18: no 424B4 yet."""
    data = copy.deepcopy(data)
    data["hits"] = [h for h in data["hits"] if h["form"] != "424B4"]
    recent = data["companies"][ANTHROPIC]["filings"]["recent"]
    keep = [i for i, form in enumerate(recent["form"]) if form != "424B4"]
    for column in list(recent):
        recent[column] = [recent[column][i] for i in keep]
    return data


@pytest.fixture
def db(migrated: Engine) -> Engine:
    with migrated.begin() as connection:
        connection.execute(text("TRUNCATE upcoming_listings CASCADE"))
        connection.execute(text("DELETE FROM instruments WHERE symbol IN ('ANT', 'OLDT')"))
    return migrated


def _row(engine: Engine, cik: str) -> Any:
    with engine.connect() as connection:
        return connection.execute(
            text("SELECT * FROM upcoming_listings WHERE cik = :cik"), {"cik": cik}
        ).one()


def _add_member(engine: Engine, symbol: str, membership: str, size_as_of: str) -> None:
    with engine.begin() as connection:
        instrument_id = connection.execute(
            text(
                "INSERT INTO instruments (symbol, asset_class) VALUES (:symbol, 'equity') "
                "RETURNING id"
            ),
            {"symbol": symbol},
        ).scalar_one()
        connection.execute(
            text(
                """
                INSERT INTO instrument_profiles (instrument_id, description, matching_text, source,
                    license, content_hash, size_as_of, membership)
                VALUES (:id, 'x', 'x', 'test', 'test', :hash, :as_of, :membership)
                """
            ),
            {"id": instrument_id, "hash": symbol, "as_of": size_as_of, "membership": membership},
        )


async def test_a_first_run_tracks_anthropic_and_excludes_the_rest(db: Engine) -> None:
    provider = CountingProvider(_data())
    report = await track_upcoming_listings(engine=db, provider=provider, today=LISTING_DAY)

    assert report.tracked == ["Anthropic, PBC"]
    assert dict(report.excluded) == {"blank_check": 1, "reporting_company": 1, "fund": 1}
    assert report.failed == [] and report.deferred == 0
    row = _row(db, ANTHROPIC)
    assert (row.stage, row.stage_on) == ("priced", LISTING_DAY)
    assert (row.ticker, row.exchange) == ("ANT", None)
    assert row.confidential_on == date(2026, 6, 1)
    assert row.filed_on == date(2026, 10, 26)
    assert row.registered_on == date(2026, 11, 17)
    with db.connect() as connection:
        forms = connection.execute(
            text("SELECT form FROM upcoming_listing_filings WHERE cik = :cik"), {"cik": ANTHROPIC}
        ).scalars()
        assert sorted(forms) == sorted(
            ["424B4", "8-A12B", "S-1/A", "S-1/A", "S-1/A", "S-1"] + ["DRS/A", "DRS"]
        )
        # An excluded registrant keeps its name and reason, nothing else.
        spac = connection.execute(
            text("SELECT * FROM upcoming_listings WHERE excluded = 'blank_check'")
        ).one()
        assert spac.stage is None and spac.ticker is None


async def test_a_rerun_asks_for_no_history_and_writes_nothing(db: Engine) -> None:
    await track_upcoming_listings(engine=db, provider=CountingProvider(_data()), today=LISTING_DAY)
    with db.connect() as connection:
        before = connection.execute(
            text("SELECT cik, updated_at FROM upcoming_listings ORDER BY cik")
        ).all()

    provider = CountingProvider(_data())
    report = await track_upcoming_listings(engine=db, provider=provider, today=LISTING_DAY)

    assert provider.asked == []
    assert report.tracked == [] and report.advanced == [] and not report.excluded
    with db.connect() as connection:
        after = connection.execute(
            text("SELECT cik, updated_at FROM upcoming_listings ORDER BY cik")
        ).all()
    assert after == before


async def test_a_new_filing_moves_a_tracked_company(db: Engine) -> None:
    await track_upcoming_listings(
        engine=db, provider=CountingProvider(_before_pricing(_data())), today=date(2026, 11, 18)
    )
    assert _row(db, ANTHROPIC).stage == "registered"

    provider = CountingProvider(_data())
    report = await track_upcoming_listings(engine=db, provider=provider, today=LISTING_DAY)

    # Only the company with a filing not stored yet is asked about again.
    assert provider.asked == [ANTHROPIC]
    assert report.advanced == ["Anthropic, PBC: priced"]
    assert _row(db, ANTHROPIC).priced_on == LISTING_DAY


async def test_a_ticker_the_daily_screen_admitted_is_listed(db: Engine) -> None:
    await track_upcoming_listings(engine=db, provider=CountingProvider(_data()), today=LISTING_DAY)
    with db.connect() as connection:
        assert [u.ticker for u in recent_upcoming_listings(connection, today=LISTING_DAY)] == [
            "ANT"
        ]
    _add_member(db, "ANT", "listed", "2026-11-20T00:00:00Z")

    # The read model leaves it out at once, before a run marks it.
    with db.connect() as connection:
        assert recent_upcoming_listings(connection, today=LISTING_DAY) == []

    provider = CountingProvider(_data())
    report = await track_upcoming_listings(engine=db, provider=provider, today=date(2026, 11, 20))
    assert report.listed == ["ANT"]
    row = _row(db, ANTHROPIC)
    assert (row.stage, row.listed_on) == ("listed", date(2026, 11, 20))
    # A listed company is not followed any more: nothing asked, nothing rewritten.
    again = CountingProvider(_data())
    report = await track_upcoming_listings(engine=db, provider=again, today=date(2026, 11, 21))
    assert again.asked == [] and report.listed == []


async def test_a_ticker_sec_adds_after_pricing_is_still_found(db: Engine) -> None:
    data = _data()
    data["companies"][ANTHROPIC]["tickers"] = []
    data["companies"][ANTHROPIC]["exchanges"] = []
    await track_upcoming_listings(engine=db, provider=CountingProvider(data), today=LISTING_DAY)
    assert _row(db, ANTHROPIC).ticker is None

    # Nothing new is filed, but a priced company without a ticker is asked again.
    data["companies"][ANTHROPIC]["tickers"] = ["ANT"]
    data["companies"][ANTHROPIC]["exchanges"] = ["Nasdaq"]
    _add_member(db, "ANT", "listed", "2026-11-20T00:00:00Z")
    provider = CountingProvider(data)
    report = await track_upcoming_listings(engine=db, provider=provider, today=date(2026, 11, 20))
    assert provider.asked == [ANTHROPIC]
    assert report.listed == ["ANT"]
    assert (_row(db, ANTHROPIC).ticker, _row(db, ANTHROPIC).exchange) == ("ANT", "Nasdaq")


async def test_a_hit_of_a_form_never_stored_does_not_refetch(db: Engine) -> None:
    data = _data()
    await track_upcoming_listings(engine=db, provider=CountingProvider(data), today=LISTING_DAY)
    data["hits"].append(
        {
            "cik": ANTHROPIC,
            "accession": "0001628280-26-074904",
            "form": "S-1MEF",
            "filed_on": "2026-11-18",
        }
    )
    provider = CountingProvider(data)
    await track_upcoming_listings(engine=db, provider=provider, today=LISTING_DAY)
    assert provider.asked == []


async def test_a_refused_history_fails_the_run(db: Engine) -> None:
    class Refusing(CountingProvider):
        async def company(self, cik: str) -> CompanyFilings:
            raise FilingsProviderError("edgar", "HTTP 403", refused=True)

    with pytest.raises(FilingsProviderError):
        await track_upcoming_listings(engine=db, provider=Refusing(_data()), today=LISTING_DAY)


async def test_an_older_member_under_the_same_ticker_is_another_company(db: Engine) -> None:
    data = _data()
    data["companies"][ANTHROPIC]["tickers"] = ["OLDT"]
    _add_member(db, "OLDT", "screened", "2026-09-24T00:00:00Z")

    report = await track_upcoming_listings(
        engine=db, provider=CountingProvider(data), today=LISTING_DAY
    )

    assert report.listed == []
    assert _row(db, ANTHROPIC).stage == "priced"

    # A snapshot sized after its pricing does hold it: the rescreen of 12-24.
    with db.begin() as connection:
        connection.execute(
            text(
                "UPDATE instrument_profiles SET size_as_of = '2026-12-24T00:00:00Z' "
                "WHERE content_hash = 'OLDT'"
            )
        )
    report = await track_upcoming_listings(
        engine=db, provider=CountingProvider(data), today=date(2026, 12, 24)
    )
    assert report.listed == ["OLDT"]


async def test_a_history_that_failed_is_asked_again_next_run(db: Engine) -> None:
    data = _data()
    anthropic = data["companies"].pop(ANTHROPIC)
    report = await track_upcoming_listings(
        engine=db, provider=CountingProvider(data), today=LISTING_DAY
    )
    assert report.failed == [ANTHROPIC]

    data["companies"][ANTHROPIC] = anthropic
    provider = CountingProvider(data)
    report = await track_upcoming_listings(engine=db, provider=provider, today=LISTING_DAY)
    assert provider.asked == [ANTHROPIC]
    assert report.tracked == ["Anthropic, PBC"]


async def test_the_cap_defers_the_rest_to_the_next_run(db: Engine) -> None:
    data: dict[str, Any] = {"hits": [], "companies": {}}
    template = _data()["companies"]["0009000002"]
    for n in range(MAX_COMPANIES_PER_RUN + 2):
        cik = f"{8_000_000_000 + n:010d}"
        accession = f"{cik}-26-000001"
        data["hits"].append(
            {"cik": cik, "accession": accession, "form": "S-1", "filed_on": "2026-11-10"}
        )
        body = copy.deepcopy(template)
        body["cik"] = cik
        body["filings"]["recent"]["accessionNumber"][0] = accession
        data["companies"][cik] = body

    provider = CountingProvider(data)
    report = await track_upcoming_listings(engine=db, provider=provider, today=LISTING_DAY)
    assert len(provider.asked) == MAX_COMPANIES_PER_RUN
    assert report.deferred == 2

    provider = CountingProvider(data)
    report = await track_upcoming_listings(engine=db, provider=provider, today=LISTING_DAY)
    assert len(provider.asked) == 2 and report.deferred == 0


async def test_the_read_model_is_pending_recent_and_newest_first(db: Engine) -> None:
    with db.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO upcoming_listings (cik, company_name, stage, stage_on, filed_on) VALUES
                  ('0000000101', 'Old Filer', 'filed', :old, :old),
                  ('0000000102', 'Recent Filer', 'filed', '2026-11-10', '2026-11-10'),
                  ('0000000103', 'Registered Co', 'registered', '2026-11-15', '2026-11-01'),
                  ('0000000104', 'Withdrawn Co', 'withdrawn', '2026-11-16', '2026-11-01'),
                  ('0000000105', 'Draft Co', 'confidential', '2026-11-16', NULL)
                """
            ),
            # Just outside the read model's window, whatever it is tuned to.
            {"old": LISTING_DAY - timedelta(days=RECENT_DAYS + 1)},
        )
        connection.execute(
            text(
                """
                INSERT INTO upcoming_listing_filings (accession, cik, form, stage, filed_on, url)
                VALUES ('0000000103-26-000002', '0000000103', '8-A12B', 'registered',
                        '2026-11-15', 'https://www.sec.gov/Archives/edgar/data/103/x/a.htm')
                """
            )
        )
        rows = recent_upcoming_listings(connection, today=LISTING_DAY)
        assert [r.company_name for r in rows] == ["Registered Co", "Recent Filer"]
        assert rows[0].url == "https://www.sec.gov/Archives/edgar/data/103/x/a.htm"
        assert rows[1].url is None
        assert {r.stage for r in rows} <= set(PENDING_STAGES)
        assert len(recent_upcoming_listings(connection, today=LISTING_DAY, limit=1)) == 1


async def test_the_app_role_can_run_it(db: Engine, as_app: Engine) -> None:
    report = await track_upcoming_listings(
        engine=as_app, provider=CountingProvider(_data()), today=LISTING_DAY
    )
    assert report.tracked == ["Anthropic, PBC"]
