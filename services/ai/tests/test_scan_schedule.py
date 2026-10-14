"""The next scheduled scan the assistant names, and its agreement with the orchestrator's."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app.agents.scan_schedule import (
    NEXT_SLOT_HORIZON,
    NY_1000_AFTER_OPEN,
    NY_1400_AFTER_OPEN,
    POST_CLOSE_LAG,
    PRE_OPEN_LEAD,
    SCHEDULE_SLOTS,
    Scheduling,
    describe_next_scan,
    next_scan,
)
from app.core.exchange_calendar import load_calendar

ROOT = Path(__file__).resolve().parents[3]
CALENDAR_DIR = ROOT / "data" / "calendar"
SCAN_SCHEDULE_TS = ROOT / "apps" / "orchestrator" / "src" / "services" / "scanSchedule.ts"
AGENTS_ROUTE_TS = ROOT / "apps" / "orchestrator" / "src" / "http" / "routes" / "agents.ts"
NEW_YORK = ZoneInfo("America/New_York")


@pytest.fixture(scope="module")
def calendar():
    return load_calendar(str(CALENDAR_DIR))


def ny(year: int, month: int, day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=NEW_YORK).astimezone(UTC)


# -- agreement with scanSchedule.ts -----------------------------------------------


def _ms(expression: str) -> int:
    """A TypeScript duration like `4 * 60 * MINUTE + 30 * MINUTE`, in milliseconds."""
    arithmetic = expression.replace("MINUTE", "60000")
    assert re.fullmatch(r"[\d\s*+]+", arithmetic), expression
    total = 0
    for term in arithmetic.split("+"):
        product = 1
        for factor in term.split("*"):
            product *= int(factor)
        total += product
    return total


def _ts_constant(source: str, name: str) -> timedelta:
    match = re.search(rf"(?:export )?const {name} = ([^;]+);", source)
    assert match, f"{name} not found in scanSchedule.ts"
    return timedelta(milliseconds=_ms(match.group(1)))


def test_the_slot_times_are_the_orchestrators() -> None:
    """The assistant names the time a scan will start; the orchestrator starts it.
    Two copies that drift would make the answer wrong."""
    source = SCAN_SCHEDULE_TS.read_text()

    assert _ts_constant(source, "PRE_OPEN_LEAD_MS") == PRE_OPEN_LEAD
    assert _ts_constant(source, "POST_CLOSE_LAG_MS") == POST_CLOSE_LAG
    assert _ts_constant(source, "NY_1000_AFTER_OPEN_MS") == NY_1000_AFTER_OPEN
    assert _ts_constant(source, "NY_1400_AFTER_OPEN_MS") == NY_1400_AFTER_OPEN


def test_the_schedules_and_their_slots_are_the_orchestrators() -> None:
    source = SCAN_SCHEDULE_TS.read_text()
    block = re.search(r"SCHEDULE_SLOTS[^=]*= \{(.*?)\};", source, re.DOTALL)
    assert block, "SCHEDULE_SLOTS not found in scanSchedule.ts"

    theirs = {
        name: tuple(re.findall(r"'(\w+)'", slots))
        for name, slots in re.findall(r"(\w+): \[([^\]]*)\]", block.group(1))
    }

    assert theirs == SCHEDULE_SLOTS


def test_the_horizon_is_the_orchestrators() -> None:
    match = re.search(r"NEXT_SLOT_HORIZON_MS = ([^;]+);", AGENTS_ROUTE_TS.read_text())
    assert match, "NEXT_SLOT_HORIZON_MS not found in routes/agents.ts"

    assert timedelta(milliseconds=_ms(match.group(1))) == NEXT_SLOT_HORIZON


# -- the next slot -----------------------------------------------------------------


def test_the_next_pre_open_slot_skips_the_weekend(calendar) -> None:
    found = next_scan("pre_open", calendar, ny(2026, 10, 16, 10))

    assert found is not None
    assert found.slot == "pre_open"
    assert found.at == ny(2026, 10, 19, 9, 30) - PRE_OPEN_LEAD


def test_the_post_close_slot_follows_the_same_days_open(calendar) -> None:
    found = next_scan("pre_open_post_close", calendar, ny(2026, 10, 15, 12))

    assert found is not None
    assert found.slot == "post_close"
    assert found.at == ny(2026, 10, 15, 16) + POST_CLOSE_LAG


def test_an_early_close_drops_the_afternoon_slot(calendar) -> None:
    """2026-11-27 closes at 13:00: the 14:00 slot does not happen that day."""
    found = next_scan("intraday_twice", calendar, ny(2026, 11, 27, 11))

    assert found is not None
    assert found.at == ny(2026, 11, 30, 9, 30) + NY_1000_AFTER_OPEN


def test_a_holiday_has_no_slot(calendar) -> None:
    """Thanksgiving, 2026-11-26: closed, so the next 10:00 slot is the next day's."""
    found = next_scan("intraday_once", calendar, ny(2026, 11, 25, 12))

    assert found is not None
    assert found.at == ny(2026, 11, 27, 9, 30) + NY_1000_AFTER_OPEN


# -- what the assistant is told ------------------------------------------------------


def _scheduling(calendar, enabled: bool = True) -> Scheduling:
    return Scheduling(enabled=enabled, calendar=calendar, timezone="Asia/Jerusalem")


def test_the_next_scan_is_given_in_the_users_time_zone(calendar) -> None:
    now = ny(2026, 10, 16, 10)

    described = describe_next_scan(
        schedule="pre_open",
        state="active",
        persona="Follows strength.",
        scheduling=_scheduling(calendar),
        now=now,
    )

    expected = (ny(2026, 10, 19, 9, 30) - PRE_OPEN_LEAD).astimezone(ZoneInfo("Asia/Jerusalem"))
    assert described["at"] == (ny(2026, 10, 19, 9, 30) - PRE_OPEN_LEAD).isoformat()
    assert described["local"] == {
        "date": "2026-10-19",
        "weekday": "Monday",
        "time": expected.strftime("%H:%M"),
        "time_zone": "Asia/Jerusalem",
    }


@pytest.mark.parametrize(
    ("enabled", "state", "persona", "why"),
    [
        (False, "active", "Follows strength.", "does not run scheduled scans"),
        (True, "paused", "Follows strength.", "paused"),
        (True, "active", "  ", "no persona"),
    ],
)
def test_no_next_scan_says_why(calendar, enabled: bool, state: str, persona: str, why: str) -> None:
    described = describe_next_scan(
        schedule="pre_open",
        state=state,
        persona=persona,
        scheduling=_scheduling(calendar, enabled),
        now=ny(2026, 10, 16, 10),
    )

    assert described["at"] is None
    assert why in described["why_none"]


def test_an_unreadable_calendar_leaves_the_next_scan_unknown() -> None:
    described = describe_next_scan(
        schedule="pre_open",
        state="active",
        persona="Follows strength.",
        scheduling=Scheduling(enabled=True, calendar=None, timezone="Asia/Jerusalem"),
        now=ny(2026, 10, 16, 10),
    )

    assert described["at"] is None and "calendar" in described["why_none"]
