"""When an agent's next scheduled scan starts, for the assistant to say (D68, D71).

The orchestrator decides when scans run (`services/scanSchedule.ts`); this holds
only what answering "when is the next scan?" needs - each schedule's slots and
each slot's time from the day's session - and none of the windows, retries or
queue. A contract test holds the times and the schedules equal to the
orchestrator's: two copies that drift would make the answer wrong.

**Every time is read from the day's session**, as there: the calendar gives each
trading day's open and close in UTC, the open is 09:30 New York on every trading
day, and a day with no session has no slots. A market-hours slot that would fall
after an early close does not happen.

**Whether scans run at all is the installation's** (D71, `ENABLE_SCHEDULED_SCANS`,
read by both services from the same environment): where it is off there is no
next scan, and the answer says so rather than naming a slot that will not run.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.core.exchange_calendar import CalendarNotCovered, ExchangeCalendar

#: D68: thirty minutes before the open.
PRE_OPEN_LEAD = timedelta(minutes=30)
#: D68: fifteen minutes after the close, an early one included.
POST_CLOSE_LAG = timedelta(minutes=15)
#: 10:00 and 14:00 New York, from an open that is always 09:30 there.
NY_1000_AFTER_OPEN = timedelta(minutes=30)
NY_1400_AFTER_OPEN = timedelta(hours=4, minutes=30)

#: Which slots each schedule runs, in the order of the day (D46's four choices).
SCHEDULE_SLOTS: dict[str, tuple[str, ...]] = {
    "pre_open": ("pre_open",),
    "pre_open_post_close": ("pre_open", "post_close"),
    "intraday_twice": ("ny_1000", "ny_1400"),
    "intraday_once": ("ny_1000",),
}
#: A week of sessions ahead holds the next slot even across a long weekend
#: (the orchestrator's `NEXT_SLOT_HORIZON_MS`).
NEXT_SLOT_HORIZON = timedelta(days=7)


@dataclass(frozen=True)
class Scheduling:
    """What the next-scan answer reads: the installation's switch, the calendar
    (None when it could not be read), and the user's time zone to say it in."""

    enabled: bool
    calendar: ExchangeCalendar | None
    timezone: str


@dataclass(frozen=True)
class NextScan:
    slot: str
    at: datetime


def _slot_time(slot: str, opens_at: datetime, closes_at: datetime) -> datetime:
    if slot == "pre_open":
        return opens_at - PRE_OPEN_LEAD
    if slot == "ny_1000":
        return opens_at + NY_1000_AFTER_OPEN
    if slot == "ny_1400":
        return opens_at + NY_1400_AFTER_OPEN
    if slot == "post_close":
        return closes_at + POST_CLOSE_LAG
    raise ValueError(f"unknown scan slot {slot!r}")


def next_scan(schedule: str, calendar: ExchangeCalendar, now: datetime) -> NextScan | None:
    """The first slot of `schedule` that starts after `now`; None when the
    horizon holds none. Raises `CalendarNotCovered` past the calendar's years."""
    slots = SCHEDULE_SLOTS.get(schedule)
    if slots is None:
        return None
    start = now.date() - timedelta(days=1)
    upcoming: list[NextScan] = []
    for session in calendar.sessions_between(start, (now + NEXT_SLOT_HORIZON).date()):
        for slot in slots:
            at = _slot_time(slot, session.opens_at, session.closes_at)
            if slot in ("ny_1000", "ny_1400") and at >= session.closes_at:
                continue
            if at > now:
                upcoming.append(NextScan(slot=slot, at=at))
    return min(upcoming, key=lambda scan: scan.at, default=None)


def describe_next_scan(
    *,
    schedule: str | None,
    state: str,
    ready: bool,
    scheduling: Scheduling | None,
    now: datetime,
) -> dict[str, object]:
    """The next scan as the assistant reports it: its time in UTC and in the
    user's zone, written so a reply can quote it, or why there is none."""
    if scheduling is None:
        return {"at": None, "why_none": "when scheduled scans run is not known here"}
    if scheduling.calendar is None:
        return {"at": None, "why_none": "the exchange calendar could not be read"}
    if not scheduling.enabled:
        return {"at": None, "why_none": "this installation does not run scheduled scans"}
    if state != "active":
        return {"at": None, "why_none": f"the agent is {state}, so it does not scan"}
    if not ready:
        return {
            "at": None,
            "why_none": "the agent has neither instructions nor settings, so it does not scan",
        }
    try:
        found = next_scan(schedule or "", scheduling.calendar, now)
    except CalendarNotCovered:
        found = None
    if found is None:
        return {"at": None, "why_none": "no slot of its schedule falls in the coming week"}
    local = found.at.astimezone(ZoneInfo(scheduling.timezone))
    return {
        "at": found.at.isoformat(),
        "slot": found.slot,
        "local": {
            "date": local.date().isoformat(),
            "weekday": local.strftime("%A"),
            "time": local.strftime("%H:%M"),
            "time_zone": scheduling.timezone,
        },
    }
