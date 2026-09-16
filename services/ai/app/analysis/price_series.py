"""A price history, and the statistics the rules read off it.

This module owns every piece of arithmetic the rules share, so that each rule is
left with one comparison and one evidence mapping. Three properties of the input
shape the whole file:

  * **`as_of` is an observation time, not a fetch time** (app/core/observation_time.py).
    It is floored to the provider's freshness window, so two rows can carry the
    same timestamp - the same observation written twice with a corrected price.
    `normalise` collapses those, keeping the last value for a timestamp.
  * **Gaps are normal.** Weekends, holidays and a symbol that stopped being
    priced all produce them, and no market calendar exists in this service (the
    same stance as `cache_policy.is_us_market_open`, and for the same reason: a
    holiday table rots silently every January). So a gap is handled by measuring
    it: every step carries `gap_days`, and a rule that would misdescribe a wide
    gap as "1-day" simply refuses it.
  * **Money is integer minor units.** Prices stay `int` here. A *return* is a
    ratio of two prices - dimensionless, no currency, no rounding boundary - and
    floats are the right type for it; the same goes for a standard deviation and
    a z-score. The division is done once, from exact integers, so the only float
    error is the final representation.

Everything here is pure: no clock, no I/O.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

#: Widest gap, in calendar days, that a "1-day" step may span. A US session can
#: legitimately be four calendar days from the previous one (Friday to Tuesday
#: after a Monday holiday), and five over Thanksgiving-shaped weeks, so five is
#: the smallest value that does not reject ordinary trading. Beyond it the two
#: prices are simply not consecutive days, and calling their difference a daily
#: move would be a false statement about the market.
DEFAULT_MAX_GAP_DAYS = 5


@dataclass(frozen=True, slots=True)
class PricePoint:
    """One row of `quotes`: an observation time, a price, a currency."""

    as_of: datetime
    price_minor: int
    currency: str


@dataclass(frozen=True, slots=True)
class Step:
    """The move between two consecutive observations.

    `return_ratio` is `(current - previous) / previous`, a float because it is a
    ratio rather than an amount of money.
    """

    previous: PricePoint
    current: PricePoint
    return_ratio: float
    gap_days: float

    def within_gap(self, max_gap_days: float) -> bool:
        return self.gap_days <= max_gap_days


def normalise(points: Iterable[PricePoint]) -> list[PricePoint]:
    """Sort ascending by observation time, drop unusable rows, collapse to daily closes.

    Every rule in this package reasons in days - a one-day move, a standard
    deviation of daily returns, a drawdown over a window of days - so the series
    they see must be one observation per day. The stored series is not: the
    portfolio endpoint records a quote on every page load, so an actively used
    dashboard writes many rows a day. Left intraday, "the latest one-day move"
    becomes the gap between two observations minutes apart, which is ~0% - the
    rules would fall silent precisely when someone is using the product, and
    look correct while doing it.

    The last observation of each UTC day wins, which is the closest thing to a
    close that a series without exchange calendars can offer. UTC rather than
    market-local because the instrument's exchange is not available here; for US
    sessions the two agree, and for a 20:00 UTC close they agree everywhere west
    of the date line. Noted as a limitation rather than hidden.

    Three defects are filtered here rather than inside each rule:

      * a non-positive price, which is a provider or import defect and cannot be
        the denominator of a return - dropping it is right, because pricing a
        holding at zero is exactly the invented number this project forbids;
      * a naive timestamp, normalised to UTC so comparisons are meaningful (the
        column is `timestamptz` and the repository stores UTC, so an offset-free
        value reaching here means a caller built it by hand);
      * two rows sharing an `as_of`, where the later row in input order wins. The
        primary key is `(instrument_id, as_of)` so this cannot happen from a
        single SELECT, but a caller merging a freshly fetched quote into a loaded
        series will produce it, and the fresh value is the one to keep.
    """
    cleaned: dict[datetime, PricePoint] = {}
    for point in points:
        if point.price_minor <= 0:
            continue
        moment = point.as_of if point.as_of.tzinfo else point.as_of.replace(tzinfo=UTC)
        moment = moment.astimezone(UTC)
        cleaned[moment] = PricePoint(moment, point.price_minor, point.currency)

    # Collapse to one point per UTC day, keeping the last observation of each.
    daily: dict[object, PricePoint] = {}
    for moment in sorted(cleaned):
        daily[moment.date()] = cleaned[moment]
    cleaned = {point.as_of: point for point in daily.values()}
    return [cleaned[key] for key in sorted(cleaned)]


def steps(points: Sequence[PricePoint]) -> list[Step]:
    """Every consecutive pair of `points`, as returns.

    A pair whose two points are denominated differently is skipped: a price in
    EUR over a price in USD is an FX rate multiplied by a return, not a return,
    and no rule in this package is entitled to guess which. This happens when an
    instrument is redenominated or when two providers disagree about a listing's
    currency.

    `points` is expected to come from `normalise`.
    """
    result: list[Step] = []
    for previous, current in zip(points, points[1:], strict=False):
        if previous.currency != current.currency:
            continue
        change = current.price_minor - previous.price_minor
        # Integer minor units divided into a float exactly once: the ratio is
        # dimensionless, so no money leaves this expression.
        ratio = change / previous.price_minor
        gap = (current.as_of - previous.as_of).total_seconds() / 86_400
        result.append(Step(previous=previous, current=current, return_ratio=ratio, gap_days=gap))
    return result


def window(points: Sequence[PricePoint], *, days: float) -> list[PricePoint]:
    """The tail of `points` within `days` calendar days of the last observation.

    Anchored on the last observation rather than on "now" because this module
    never reads a clock: a rule describes the series it was handed. Whether that
    series is too stale to act on is the caller's question, and the caller has
    the run's clock.
    """
    if not points:
        return []
    cutoff = points[-1].as_of.timestamp() - days * 86_400
    return [point for point in points if point.as_of.timestamp() >= cutoff]


def trailing_high(points: Sequence[PricePoint]) -> PricePoint | None:
    """The highest-priced point, earliest one winning a tie.

    The earliest wins so that a flat top reports the date the level was first
    reached, which is the more informative of the two for "down x% from its high
    on <date>".
    """
    best: PricePoint | None = None
    for point in points:
        if best is None or point.price_minor > best.price_minor:
            best = point
    return best


def sample_stdev(values: Sequence[float]) -> float | None:
    """Bessel-corrected standard deviation, or None for fewer than two values.

    n-1 rather than n because the sample *is* a sample - twenty observed daily
    returns standing in for the instrument's volatility - and the uncorrected
    form biases that estimate low, which inflates every z-score computed from it.

    The mean is not assumed to be zero. Over twenty days a trending instrument
    has a visibly non-zero mean return, and treating it as zero would charge the
    trend to volatility and quietly shrink the z-score of a real shock.
    """
    if len(values) < 2:
        return None
    mean = math.fsum(values) / len(values)
    variance = math.fsum((value - mean) ** 2 for value in values) / (len(values) - 1)
    return math.sqrt(variance)
