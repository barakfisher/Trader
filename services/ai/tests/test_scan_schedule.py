"""The next scheduled scan the assistant names, and its agreement with the orchestrator's."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app.agents.scan_schedule import (
    FIRST_MARKET_SCAN_AFTER_OPEN,
    FIRST_MARKET_SCAN_HOUR,
    NEXT_SLOT_HORIZON,
    POST_CLOSE_LAG,
    PRE_OPEN_LEAD,
    ScanSchedule,
    Scheduling,
    describe_next_scan,
    next_scan,
    slots_of,
)
from app.core.exchange_calendar import load_calendar

ROOT = Path(__file__).resolve().parents[3]
CALENDAR_DIR = ROOT / "data" / "calendar"
SCAN_SCHEDULE_TS = ROOT / "apps" / "orchestrator" / "src" / "services" / "scanSchedule.ts"
SHARED_TYPES_TS = ROOT / "packages" / "shared" / "src" / "types.ts"
AGENT_SCHEDULING_TS = ROOT / "apps" / "orchestrator" / "src" / "services" / "agentScheduling.ts"
NEW_YORK = ZoneInfo("America/New_York")

PRE_OPEN = ScanSchedule(every_hours=None, pre_open=True, post_close=False)
EDGES = ScanSchedule(every_hours=None, pre_open=True, post_close=True)
NONE = ScanSchedule(every_hours=None, pre_open=False, post_close=False)


def every(hours: int, *, pre_open: bool = False, post_close: bool = False) -> ScanSchedule:
    return ScanSchedule(every_hours=hours, pre_open=pre_open, post_close=post_close)


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


def _ts_constant(source: str, name: str) -> str:
    match = re.search(rf"(?:export )?const {name} = ([^;]+);", source)
    assert match, f"{name} not found"
    return match.group(1)


def test_the_slot_times_are_the_orchestrators() -> None:
    """The assistant names the time a scan will start; the orchestrator starts it.
    Two copies that drift would make the answer wrong."""
    source = SCAN_SCHEDULE_TS.read_text()
    shared = SHARED_TYPES_TS.read_text()

    assert timedelta(milliseconds=_ms(_ts_constant(source, "PRE_OPEN_LEAD_MS"))) == PRE_OPEN_LEAD
    assert timedelta(milliseconds=_ms(_ts_constant(source, "POST_CLOSE_LAG_MS"))) == POST_CLOSE_LAG
    minutes = int(_ts_constant(shared, "FIRST_MARKET_SCAN_AFTER_OPEN_MINUTES"))
    assert timedelta(minutes=minutes) == FIRST_MARKET_SCAN_AFTER_OPEN
    assert int(_ts_constant(source, "FIRST_MARKET_SCAN_HOUR")) == FIRST_MARKET_SCAN_HOUR


def test_the_horizon_is_the_orchestrators() -> None:
    match = re.search(r"NEXT_SLOT_HORIZON_MS = ([^;]+);", AGENT_SCHEDULING_TS.read_text())
    assert match, "NEXT_SLOT_HORIZON_MS not found in services/agentScheduling.ts"

    assert timedelta(milliseconds=_ms(match.group(1))) == NEXT_SLOT_HORIZON


# -- a session's slots -------------------------------------------------------------


def test_every_n_hours_runs_from_10_while_the_market_is_open() -> None:
    opens, closes = ny(2026, 10, 15, 9, 30), ny(2026, 10, 15, 16)

    names = {h: [slot.slot for slot in slots_of(every(h), opens, closes)] for h in range(1, 7)}

    assert names[1] == ["ny_1000", "ny_1100", "ny_1200", "ny_1300", "ny_1400", "ny_1500"]
    assert names[2] == ["ny_1000", "ny_1200", "ny_1400"]
    assert names[4] == ["ny_1000", "ny_1400"]
    assert names[6] == ["ny_1000"]


def test_the_edges_combine_with_market_hours_in_the_order_of_the_day() -> None:
    opens, closes = ny(2026, 10, 15, 9, 30), ny(2026, 10, 15, 16)

    slots = slots_of(every(3, pre_open=True, post_close=True), opens, closes)

    assert [s.slot for s in slots] == ["pre_open", "ny_1000", "ny_1300", "post_close"]
    assert slots[0].at == opens - PRE_OPEN_LEAD and slots[-1].at == closes + POST_CLOSE_LAG


def test_no_schedule_has_no_slots() -> None:
    assert slots_of(NONE, ny(2026, 10, 15, 9, 30), ny(2026, 10, 15, 16)) == []


# -- the next slot -----------------------------------------------------------------


def test_the_next_pre_open_slot_skips_the_weekend(calendar) -> None:
    found = next_scan(PRE_OPEN, calendar, ny(2026, 10, 16, 10))

    assert found is not None
    assert found.slot == "pre_open"
    assert found.at == ny(2026, 10, 19, 9, 30) - PRE_OPEN_LEAD


def test_the_post_close_slot_follows_the_same_days_open(calendar) -> None:
    found = next_scan(EDGES, calendar, ny(2026, 10, 15, 12))

    assert found is not None
    assert found.slot == "post_close"
    assert found.at == ny(2026, 10, 15, 16) + POST_CLOSE_LAG


def test_an_early_close_drops_the_afternoon_slot(calendar) -> None:
    """2026-11-27 closes at 13:00: the 14:00 slot does not happen that day."""
    found = next_scan(every(4), calendar, ny(2026, 11, 27, 11))

    assert found is not None
    assert found.at == ny(2026, 11, 30, 9, 30) + FIRST_MARKET_SCAN_AFTER_OPEN


def test_a_holiday_has_no_slot(calendar) -> None:
    """Thanksgiving, 2026-11-26: closed, so the next 10:00 slot is the next day's."""
    found = next_scan(every(6), calendar, ny(2026, 11, 25, 12))

    assert found is not None
    assert found.at == ny(2026, 11, 27, 9, 30) + FIRST_MARKET_SCAN_AFTER_OPEN


# -- what the assistant is told ------------------------------------------------------


def _scheduling(calendar, enabled: bool = True) -> Scheduling:
    return Scheduling(enabled=enabled, calendar=calendar, timezone="Asia/Jerusalem")


def test_the_next_scan_is_given_in_the_users_time_zone(calendar) -> None:
    now = ny(2026, 10, 16, 10)

    described = describe_next_scan(
        schedule=PRE_OPEN,
        state="active",
        ready=True,
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
    ("enabled", "state", "ready", "why"),
    [
        (False, "active", True, "does not run scheduled scans"),
        (True, "paused", True, "paused"),
        (True, "active", False, "neither instructions nor settings"),
    ],
)
def test_no_next_scan_says_why(calendar, enabled: bool, state: str, ready: bool, why: str) -> None:
    described = describe_next_scan(
        schedule=PRE_OPEN,
        state=state,
        ready=ready,
        scheduling=_scheduling(calendar, enabled),
        now=ny(2026, 10, 16, 10),
    )

    assert described["at"] is None
    assert why in described["why_none"]


def test_an_unreadable_calendar_leaves_the_next_scan_unknown() -> None:
    described = describe_next_scan(
        schedule=PRE_OPEN,
        state="active",
        ready=True,
        scheduling=Scheduling(enabled=True, calendar=None, timezone="Asia/Jerusalem"),
        now=ny(2026, 10, 16, 10),
    )

    assert described["at"] is None and "calendar" in described["why_none"]


def test_no_scheduled_scans_says_it_scans_only_when_asked(calendar) -> None:
    described = describe_next_scan(
        schedule=NONE,
        state="active",
        ready=True,
        scheduling=_scheduling(calendar),
        now=ny(2026, 10, 16, 10),
    )

    assert described["at"] is None and "only when asked" in described["why_none"]
