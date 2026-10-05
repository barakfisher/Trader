"""When the US exchanges are open, holidays and early closes included (decision D25).

`market_sessions.py` knows each exchange's regular hours and deliberately
ignores holidays: there, being wrong costs a few extra quote requests. A fill
is different. A manual trade at the live quote (D21), and in Stage 4 an
approval (D3, D4), may happen only while the exchange is open, and a proposal's
TTL starts at the next open - so a closed Thanksgiving read as an open Thursday
would fill at a price nobody could have traded at.

The days come from `data/calendar/xnys.json`, a committed file written by
`scripts/generate_exchange_calendar.py` from NYSE's rules
(`nyse_holiday_rules.py`) plus closures added by hand. Committed rather than
computed here, for the reason the universe is (decision 90): CI, the eval and
production read one fixed input, and a change to it shows in a diff. NYSE and
Nasdaq share the calendar, and every instrument an agent can trade is listed on
one of them (spec §13.1).

**Outside the years the file covers, nothing is guessed.** `CalendarNotCovered`
is raised instead, and a test fails 90 days before the last covered day, so the
file is extended long before anyone could meet the error.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

from app.core.market_sessions import US, known_session

#: The calendar's file name inside `calendar_dir`, and its identifier (ISO 10383 MIC).
XNYS = "XNYS"
CALENDAR_FILE = "xnys.json"

#: How far ahead `next_open` searches before deciding the file is wrong. The
#: longest real run of closed weekdays is two (a holiday beside a weekend, or
#: 2012's hurricane); a fortnight with no session means a broken file, not a
#: long weekend.
MAX_CLOSED_DAYS = 14


class CalendarNotCovered(LookupError):
    """A day outside the years the committed calendar covers."""


@dataclass(frozen=True)
class TradingSession:
    """One day's regular session, as instants in UTC."""

    day: date
    opens_at: datetime
    closes_at: datetime
    early_close: bool


def _minutes(text: str) -> int:
    hours, minutes = text.split(":")
    return int(hours) * 60 + int(minutes)


@dataclass(frozen=True)
class ExchangeCalendar:
    name: str
    timezone: str
    open_minute: int
    close_minute: int
    early_close_minute: int
    first_day: date
    last_day: date
    closures: dict[date, str]
    early_closes: dict[date, str]

    def covers(self, day: date) -> bool:
        return self.first_day <= day <= self.last_day

    def session_on(self, day: date) -> TradingSession | None:
        """The day's session, or None when the exchange does not trade that day."""
        if not self.covers(day):
            raise CalendarNotCovered(
                f"{self.name} calendar covers {self.first_day}..{self.last_day}, not {day}"
            )
        if day.weekday() >= 5 or day in self.closures:
            return None
        early = day in self.early_closes
        zone = ZoneInfo(self.timezone)

        def at(minute: int) -> datetime:
            local = datetime.combine(day, time(minute // 60, minute % 60), tzinfo=zone)
            return local.astimezone(UTC)

        return TradingSession(
            day=day,
            opens_at=at(self.open_minute),
            closes_at=at(self.early_close_minute if early else self.close_minute),
            early_close=early,
        )

    def local_day(self, now: datetime) -> date:
        return now.astimezone(ZoneInfo(self.timezone)).date()

    def current_session(self, now: datetime) -> TradingSession | None:
        """The session `now` falls inside - [open, close) - or None while closed."""
        session = self.session_on(self.local_day(now))
        if session is not None and session.opens_at <= now < session.closes_at:
            return session
        return None

    def is_open(self, now: datetime) -> bool:
        return self.current_session(now) is not None

    def next_session(self, now: datetime) -> TradingSession:
        """The first session that opens strictly after `now`.

        While the exchange is open this is tomorrow's (or the next trading
        day's): a caller computing D4's TTL start uses `now` itself when
        `is_open(now)`, and this otherwise.
        """
        day = self.local_day(now)
        for _ in range(MAX_CLOSED_DAYS + 1):
            session = self.session_on(day)
            if session is not None and session.opens_at > now:
                return session
            day += timedelta(days=1)
        raise CalendarNotCovered(
            f"{self.name} calendar has no session within {MAX_CLOSED_DAYS} days of {now}"
        )


def parse_calendar(document: dict) -> ExchangeCalendar:
    """Build a calendar from the file's JSON, refusing a file that contradicts itself."""
    first_year, last_year = int(document["first_year"]), int(document["last_year"])
    calendar = ExchangeCalendar(
        name=document["calendar"],
        timezone=document["timezone"],
        open_minute=_minutes(document["open"]),
        close_minute=_minutes(document["close"]),
        early_close_minute=_minutes(document["early_close"]),
        first_day=date(first_year, 1, 1),
        last_day=date(last_year, 12, 31),
        closures={date.fromisoformat(row["date"]): row["name"] for row in document["closures"]},
        early_closes={
            date.fromisoformat(row["date"]): row["name"] for row in document["early_closes"]
        },
    )
    for day in (*calendar.closures, *calendar.early_closes):
        if not calendar.covers(day) or day.weekday() >= 5:
            raise ValueError(f"{calendar.name}: {day} is outside the years or on a weekend")
    both = set(calendar.closures) & set(calendar.early_closes)
    if both:
        raise ValueError(f"{calendar.name}: closed and closing early on {sorted(both)}")
    if (calendar.timezone, calendar.open_minute, calendar.close_minute) != (
        US.timezone,
        US.open_minute,
        US.close_minute,
    ):
        raise ValueError(f"{calendar.name}: hours disagree with market_sessions.US")
    return calendar


@lru_cache(maxsize=4)
def load_calendar(calendar_dir: str) -> ExchangeCalendar:
    """The committed calendar, read once per process (the file changes only with a deploy)."""
    path = Path(calendar_dir) / CALENDAR_FILE
    return parse_calendar(json.loads(path.read_text(encoding="utf-8")))


def calendar_name_for(exchange: str | None) -> str | None:
    """The calendar an exchange trades on, or None when no calendar is held for it.

    Only the US session has one. Unlike `session_for`, an unknown exchange is not
    assumed to be American: a trade on a guessed calendar is a wrong fill.
    """
    return XNYS if known_session(exchange) is US else None
