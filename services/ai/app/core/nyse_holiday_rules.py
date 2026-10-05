"""NYSE's holiday rules, as the exchange publishes them, for the calendar generator.

The exchange calendar (`exchange_calendar.py`, decision D25) is a committed file,
and this module is what writes it: `scripts/generate_exchange_calendar.py` asks
it for each year's closures and early closes. Nothing reads these rules at
request time - the service reads the file, so a day can be corrected by hand
without a code change, and every reader sees the same days CI tested.

The rules (NYSE Rule 7.2 and its published holiday tables):

* **Full closures:** New Year's Day, Martin Luther King Jr. Day (third Monday of
  January), Washington's Birthday (third Monday of February), Good Friday,
  Memorial Day (last Monday of May), Juneteenth (since 2022), Independence Day,
  Labor Day (first Monday of September), Thanksgiving (fourth Thursday of
  November) and Christmas.
* **Weekend observance:** a fixed-date holiday on a Saturday is observed the
  Friday before, on a Sunday the Monday after - **except New Year's Day on a
  Saturday, which is not observed at all**, because the Friday before closes a
  different year's books (NYSE: "no New Year's Day holiday is observed", 2028).
* **Early closes at 13:00 New York:** the day after Thanksgiving; July 3 and
  December 24 when they fall Monday to Thursday. On a Friday the next day is a
  Saturday, so there is nothing to shorten for; on a weekend there is no session.

What no rule predicts - a national day of mourning, a hurricane - is added to
the file by hand with `source: "manual"`, and the generator keeps those entries.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

#: The year Juneteenth became an NYSE holiday.
JUNETEENTH_FIRST_YEAR = 2022

_MONDAY, _THURSDAY, _FRIDAY, _SATURDAY, _SUNDAY = 0, 3, 4, 5, 6


@dataclass(frozen=True)
class CalendarDay:
    """One dated exception to the regular session: a closure or an early close."""

    day: date
    name: str


def easter_sunday(year: int) -> date:
    """Gregorian Easter Sunday (the anonymous Gregorian algorithm, Meeus/Jones/Butcher)."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    el = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * el) // 451
    month, day = divmod(h + el - 7 * m + 114, 31)
    return date(year, month, day + 1)


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    following = date(year + month // 12, month % 12 + 1, 1)
    last = following - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def _observed(day: date) -> date:
    if day.weekday() == _SATURDAY:
        return day - timedelta(days=1)
    if day.weekday() == _SUNDAY:
        return day + timedelta(days=1)
    return day


def closures(year: int) -> list[CalendarDay]:
    """The year's full closures by rule, in date order."""
    days: list[CalendarDay] = []
    new_year = date(year, 1, 1)
    if new_year.weekday() != _SATURDAY:
        days.append(CalendarDay(_observed(new_year), "New Year's Day"))
    days.append(CalendarDay(_nth_weekday(year, 1, _MONDAY, 3), "Martin Luther King Jr. Day"))
    days.append(CalendarDay(_nth_weekday(year, 2, _MONDAY, 3), "Washington's Birthday"))
    days.append(CalendarDay(easter_sunday(year) - timedelta(days=2), "Good Friday"))
    days.append(CalendarDay(_last_weekday(year, 5, _MONDAY), "Memorial Day"))
    if year >= JUNETEENTH_FIRST_YEAR:
        days.append(CalendarDay(_observed(date(year, 6, 19)), "Juneteenth"))
    days.append(CalendarDay(_observed(date(year, 7, 4)), "Independence Day"))
    days.append(CalendarDay(_nth_weekday(year, 9, _MONDAY, 1), "Labor Day"))
    days.append(CalendarDay(_nth_weekday(year, 11, _THURSDAY, 4), "Thanksgiving Day"))
    days.append(CalendarDay(_observed(date(year, 12, 25)), "Christmas Day"))
    return sorted(days, key=lambda entry: entry.day)


def early_closes(year: int) -> list[CalendarDay]:
    """The year's 13:00 early closes by rule, in date order."""
    days: list[CalendarDay] = []
    july_third = date(year, 7, 3)
    if july_third.weekday() < _FRIDAY:
        days.append(CalendarDay(july_third, "Day before Independence Day"))
    thanksgiving = _nth_weekday(year, 11, _THURSDAY, 4)
    days.append(CalendarDay(thanksgiving + timedelta(days=1), "Day after Thanksgiving"))
    christmas_eve = date(year, 12, 24)
    if christmas_eve.weekday() < _FRIDAY:
        days.append(CalendarDay(christmas_eve, "Christmas Eve"))
    return days
