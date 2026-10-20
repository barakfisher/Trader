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
#: The first market-hours scan, 10:00 New York, from an open that is always 09:30 there
#: (`FIRST_MARKET_SCAN_AFTER_OPEN_MINUTES` in `packages/shared/src/types.ts`).
FIRST_MARKET_SCAN_AFTER_OPEN = timedelta(minutes=30)
#: Its hour, New York: market-hours slots are named `ny_1000` to `ny_1500`.
FIRST_MARKET_SCAN_HOUR = 10
#: A week of sessions ahead holds the next slot even across a long weekend
#: (the orchestrator's `NEXT_SLOT_HORIZON_MS`).
NEXT_SLOT_HORIZON = timedelta(days=7)


@dataclass(frozen=True)
class ScanSchedule:
    """When an agent's scheduled scans run (D195): every `every_hours` hours
    from 10:00 New York while the market is open (None: not during market
    hours), and before the open and after the close, each on its own."""

    every_hours: int | None
    pre_open: bool
    post_close: bool


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


def slots_of(schedule: ScanSchedule, opens_at: datetime, closes_at: datetime) -> list[NextScan]:
    """One session's slots, in the order of the day - `slotsOf` in `scanSchedule.ts`.
    A market-hours slot at or after the close, an early one included, does not happen."""
    slots: list[NextScan] = []
    if schedule.pre_open:
        slots.append(NextScan(slot="pre_open", at=opens_at - PRE_OPEN_LEAD))
    if schedule.every_hours is not None:
        hours = 0
        while (at := opens_at + FIRST_MARKET_SCAN_AFTER_OPEN + timedelta(hours=hours)) < closes_at:
            slots.append(NextScan(slot=f"ny_{FIRST_MARKET_SCAN_HOUR + hours}00", at=at))
            hours += schedule.every_hours
    if schedule.post_close:
        slots.append(NextScan(slot="post_close", at=closes_at + POST_CLOSE_LAG))
    return slots


def next_scan(schedule: ScanSchedule, calendar: ExchangeCalendar, now: datetime) -> NextScan | None:
    """The first slot of `schedule` that starts after `now`; None when the
    horizon holds none. Raises `CalendarNotCovered` past the calendar's years."""
    start = now.date() - timedelta(days=1)
    upcoming = [
        slot
        for session in calendar.sessions_between(start, (now + NEXT_SLOT_HORIZON).date())
        for slot in slots_of(schedule, session.opens_at, session.closes_at)
        if slot.at > now
    ]
    return min(upcoming, key=lambda scan: scan.at, default=None)


def describe_next_scan(
    *,
    schedule: ScanSchedule | None,
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
    if schedule is None or (
        schedule.every_hours is None and not schedule.pre_open and not schedule.post_close
    ):
        return {"at": None, "why_none": "no scans are scheduled: it scans only when asked"}
    try:
        found = next_scan(schedule, scheduling.calendar, now)
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
