"""The exchange calendar: its rules, its committed file, and its answers (decision D25)."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest

from app.config import get_settings
from app.core import nyse_holiday_rules as rules
from app.core.exchange_calendar import (
    CALENDAR_FILE,
    XNYS,
    CalendarNotCovered,
    calendar_name_for,
    load_calendar,
    parse_calendar,
)
from app.core.market_sessions import US
from app.main import app
from app.routers.market import calendar_status
from scripts.generate_exchange_calendar import build, render
from tests.conftest import TEST_INTERNAL_KEY

CALENDAR_DIR = Path(__file__).resolve().parents[3] / "data" / "calendar"

#: How long before the committed calendar runs out its expiry test fails.
EXPIRY_WARNING_DAYS = 90

#: NYSE's published holidays and early closes, copied from
#: https://www.nyse.com/markets/hours-calendars on 2026-10-05 - the source the
#: rules must reproduce, not a restatement of them. 2028 has no New Year's Day
#: (January 1 is a Saturday), and 2026 no July early close (July 3 is the holiday).
PUBLISHED_CLOSURES = {
    2026: ["01-01", "01-19", "02-16", "04-03", "05-25",
           "06-19", "07-03", "09-07", "11-26", "12-25"],
    2027: ["01-01", "01-18", "02-15", "03-26", "05-31",
           "06-18", "07-05", "09-06", "11-25", "12-24"],
    2028: ["01-17", "02-21", "04-14", "05-29",
           "06-19", "07-04", "09-04", "11-23", "12-25"],
}  # fmt: skip
PUBLISHED_EARLY_CLOSES = {2026: ["11-27", "12-24"], 2027: ["11-26"], 2028: ["07-03", "11-24"]}


def _days(year: int, month_days: list[str]) -> list[date]:
    return [date.fromisoformat(f"{year}-{month_day}") for month_day in month_days]


def ny(year: int, month: int, day: int, hour: int, minute: int = 0) -> datetime:
    """A New York wall-clock time as a UTC instant."""
    local = datetime(year, month, day, hour, minute, tzinfo=ZoneInfo(US.timezone))
    return local.astimezone(UTC)


@pytest.fixture
def calendar():
    return load_calendar(str(CALENDAR_DIR))


@pytest.mark.parametrize("year", sorted(PUBLISHED_CLOSURES))
def test_rules_reproduce_nyse_published_closures(year):
    assert [entry.day for entry in rules.closures(year)] == _days(year, PUBLISHED_CLOSURES[year])


@pytest.mark.parametrize("year", sorted(PUBLISHED_EARLY_CLOSES))
def test_rules_reproduce_nyse_published_early_closes(year):
    assert [entry.day for entry in rules.early_closes(year)] == _days(
        year, PUBLISHED_EARLY_CLOSES[year]
    )


def test_easter_matches_known_dates():
    assert rules.easter_sunday(2026) == date(2026, 4, 5)
    assert rules.easter_sunday(2027) == date(2027, 3, 28)
    assert rules.easter_sunday(2038) == date(2038, 4, 25)


def test_committed_file_is_what_the_generator_writes():
    """A hand edit to a rule-made day, or a rule changed without regenerating, fails here."""
    path = CALENDAR_DIR / CALENDAR_FILE
    committed = json.loads(path.read_text(encoding="utf-8"))
    expected = render(build(committed["first_year"], committed["last_year"], committed))
    assert path.read_text(encoding="utf-8") == expected


def test_regeneration_keeps_manual_entries():
    manual = {"date": "2025-01-09", "name": "Day of mourning", "source": "manual"}
    previous = {"closures": [manual], "early_closes": []}
    assert manual in build(2025, 2025, previous)["closures"]
    # ... and drops one outside the years asked, rather than carrying it silently.
    assert manual not in build(2026, 2026, previous)["closures"]


def test_calendar_covers_the_next_90_days(calendar):
    """The yearly chore: when this fails, run the generator with `--last-year` one higher."""
    horizon = datetime.now(UTC).date() + timedelta(days=EXPIRY_WARNING_DAYS)
    assert calendar.covers(horizon), (
        f"{XNYS} calendar ends {calendar.last_day}; extend it with "
        "scripts/generate_exchange_calendar.py --last-year"
    )


def test_hours_agree_with_market_sessions(calendar):
    assert calendar.timezone == US.timezone
    assert (calendar.open_minute, calendar.close_minute) == (US.open_minute, US.close_minute)


def test_a_contradictory_file_is_refused():
    document = build(2026, 2026, None)
    document["early_closes"].append({"date": "2026-12-25", "name": "x", "source": "manual"})
    with pytest.raises(ValueError):
        parse_calendar(document)
    weekend = build(2026, 2026, None)
    weekend["closures"].append({"date": "2026-10-03", "name": "x", "source": "manual"})
    with pytest.raises(ValueError):
        parse_calendar(weekend)


def test_open_during_a_regular_session(calendar):
    assert calendar.is_open(ny(2026, 10, 5, 9, 30)) is True
    assert calendar.is_open(ny(2026, 10, 5, 15, 59)) is True
    assert calendar.is_open(ny(2026, 10, 5, 9, 29)) is False
    assert calendar.is_open(ny(2026, 10, 5, 16, 0)) is False


def test_closed_on_weekends_holidays_and_manual_closures(calendar):
    assert calendar.is_open(ny(2026, 10, 3, 12)) is False  # Saturday
    assert calendar.is_open(ny(2026, 11, 26, 12)) is False  # Thanksgiving
    assert calendar.is_open(ny(2026, 7, 3, 12)) is False  # Independence Day observed
    assert calendar.is_open(ny(2025, 1, 9, 12)) is False  # added by hand


def test_early_close_ends_the_session_at_one(calendar):
    session = calendar.current_session(ny(2026, 11, 27, 12, 59))
    assert session is not None and session.early_close is True
    assert session.closes_at == ny(2026, 11, 27, 13, 0)
    assert calendar.is_open(ny(2026, 11, 27, 13, 0)) is False


def test_session_hours_follow_daylight_saving(calendar):
    # 09:30 New York is 13:30 UTC in summer and 14:30 UTC in winter.
    assert calendar.session_on(date(2026, 7, 6)).opens_at == datetime(
        2026, 7, 6, 13, 30, tzinfo=UTC
    )
    assert calendar.session_on(date(2026, 12, 7)).opens_at == datetime(
        2026, 12, 7, 14, 30, tzinfo=UTC
    )


def test_next_open_skips_weekends_and_holidays(calendar):
    # Wednesday after the close -> Friday (Thursday is Thanksgiving).
    assert calendar.next_session(ny(2026, 11, 25, 17)).opens_at == ny(2026, 11, 27, 9, 30)
    # Friday after the close -> Monday.
    assert calendar.next_session(ny(2026, 10, 9, 17)).opens_at == ny(2026, 10, 12, 9, 30)
    # Before the open -> the same day.
    assert calendar.next_session(ny(2026, 10, 5, 8)).opens_at == ny(2026, 10, 5, 9, 30)
    # While open -> the next trading day, never the session already running.
    assert calendar.next_session(ny(2026, 10, 5, 11)).opens_at == ny(2026, 10, 6, 9, 30)


def test_a_day_outside_the_file_is_never_guessed(calendar):
    with pytest.raises(CalendarNotCovered):
        calendar.session_on(calendar.last_day + timedelta(days=1))
    with pytest.raises(CalendarNotCovered):
        calendar.session_on(calendar.first_day - timedelta(days=1))


def test_only_us_exchanges_have_a_calendar():
    for exchange in ("NYQ", "NMS", "PCX", "BTS", "NASDAQ", "nyse"):
        assert calendar_name_for(exchange) == XNYS
    for exchange in ("XETRA", "CCC", "UNKNOWN", None):
        assert calendar_name_for(exchange) is None


def test_status_while_open_and_while_closed(calendar):
    open_ = calendar_status(calendar, "NYQ", ny(2026, 12, 24, 10))
    assert open_.is_open and open_.early_close
    assert open_.session_closes_at == ny(2026, 12, 24, 13)
    assert open_.next_open == ny(2026, 12, 28, 9, 30)
    closed = calendar_status(calendar, "NYQ", ny(2026, 12, 25, 10))
    assert not closed.is_open and closed.session_closes_at is None and not closed.early_close
    assert closed.covered_until == calendar.last_day


@pytest.fixture
def client(settings):
    app.dependency_overrides[get_settings] = lambda: settings
    yield httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={"x-internal-key": TEST_INTERNAL_KEY},
    )
    app.dependency_overrides.clear()


async def test_route_answers_for_a_us_exchange(client, settings):
    settings.calendar_dir = str(CALENDAR_DIR)
    async with client:
        response = await client.get("/market/calendar", params={"exchange": "NMS"})
    assert response.status_code == 200
    body = response.json()
    assert body["calendar"] == XNYS and body["exchange"] == "NMS"
    assert isinstance(body["is_open"], bool)


async def test_route_refuses_an_exchange_without_a_calendar(client):
    async with client:
        response = await client.get("/market/calendar", params={"exchange": "XETRA"})
    assert response.status_code == 422


async def test_route_answers_503_without_the_file(client, settings, tmp_path):
    settings.calendar_dir = str(tmp_path)
    async with client:
        response = await client.get("/market/calendar", params={"exchange": "NYQ"})
    assert response.status_code == 503
