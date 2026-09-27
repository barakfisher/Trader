"""Rule 5: a topic's instruments moved together, by more than the topic usually does.

A topic is a set of instruments the user confirmed (M5), so the question this rule
answers is about the set, not about any one member: "did *uranium* move today?"
The per-instrument rules already answer "did CCJ move?", for holdings, and a topic
card that listed seven of those would be a feed, not an observation.

**The basket.** The topic's move on a session is the equal-weighted mean of its
members' one-day returns. Equal weight because a confirmed set carries no weights -
the user chose *which* instruments, never how much of each - and weighting by
market value would make every topic that contains a giant a statement about that
giant. Each member's return is in its own currency, for the reason `price_move.py`
gives: a return is dimensionless, and converting it would describe neither the
instrument nor the topic.

**The statistic.** The basket's move as a z-score against the basket's own recent
daily moves, exactly as `sigma_move.py` does for one instrument, and with the same
five guards and the same thresholds. A percentage band would not do: an average of
seven uranium miners moves 3% on an ordinary day, and an average of seven utilities
almost never does. The historical basket is rebuilt day by day from whichever
members were priced on that day, so it is the same equal-weighted question asked
of each prior session.

**Two refusals of its own**, each reported as a reason rather than as silence:

1. **Too few members moved.** A "basket" of one is that instrument's sigma move
   with a topic's name on it. Below `TOPIC_MIN_MEMBERS` priced on the session the
   rule says so and stops.
2. **Too little of the topic moved.** If only three of twelve confirmed members
   were priced on the session, "the topic moved" is a claim about a quarter of it.
   Below `TOPIC_MIN_COVERAGE` of the confirmed set the rule refuses rather than
   generalise - and the same floor decides which *historical* days are allowed
   into the sample, so the denominator measures the same kind of basket as the
   numerator.

The session is the latest day on which any member has a valid one-day step. A
member whose latest price is older than that is listed in the evidence as not
priced on the session rather than dropped, because "six of seven moved" and "six
moved" are different statements and only the first is honest.

Pure: no clock, no I/O. Everything the rule sees arrives as arguments.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta

from app.analysis.findings import Finding, Severity, cap_severity, severity_for
from app.analysis.price_series import PricePoint, normalise, sample_stdev, steps
from app.analysis.thresholds import AnalysisThresholds

#: Members that must have a valid one-day move on the session. Two is the
#: smallest set whose average says something neither member says alone.
TOPIC_MIN_MEMBERS = 2

#: Fraction of the confirmed set that must be priced on a session, both for the
#: session itself and for each historical day admitted to the sample.
TOPIC_MIN_COVERAGE = 0.5

#: How many of the largest individual moves the evidence names. Enough to say
#: which names drove the basket, few enough to fit in a sentence.
TOPIC_MOVERS_SHOWN = 3

#: Same ceiling as the instrument rule when the deviation floor binds: the
#: z-score is then a bound, not a measurement, and does not get to shout.
FLOORED_SEVERITY_CEILING: Severity = "notable"


@dataclass(frozen=True, slots=True)
class TopicMember:
    """One confirmed instrument and its price history."""

    symbol: str
    points: Sequence[PricePoint]


@dataclass(frozen=True, slots=True)
class TopicMoveResult:
    """Zero or one finding, and why there is none when there is none.

    `skipped_reason` is set only when the rule could not *look* - too few members
    priced, too little history. A basket that looked and found an ordinary day
    returns no finding and no reason, because a quiet topic is an answer.
    """

    findings: list[Finding] = field(default_factory=list)
    skipped_reason: str | None = None


def topic_move_findings(
    topic_id: str,
    label: str,
    members: Sequence[TopicMember],
    thresholds: AnalysisThresholds,
) -> TopicMoveResult:
    """Zero or one `topic_move` finding for the latest session of `members`."""
    confirmed = len(members)
    if confirmed < TOPIC_MIN_MEMBERS:
        return TopicMoveResult(
            skipped_reason=f"{confirmed} confirmed instrument; a basket needs {TOPIC_MIN_MEMBERS}"
        )

    # symbol -> {session day -> that day's one-day return}, and each member's
    # latest priced point, for the evidence.
    daily: dict[str, dict[date, float]] = {}
    latest_point: dict[str, PricePoint] = {}
    for member in members:
        series = normalise(member.points)
        returns: dict[date, float] = {}
        for step in steps(series):
            if step.within_gap(thresholds.max_gap_days):
                returns[step.current.as_of.date()] = step.return_ratio
        daily[member.symbol] = returns
        if series:
            latest_point[member.symbol] = series[-1]

    # A member's move counts for a session only if that session is its latest
    # price: `steps` skips currency changes, so a member's last *return* can be
    # older than its last *price*, and reporting it would misdate the move.
    session_moves: dict[str, float] = {}
    session: date | None = None
    for symbol, returns in daily.items():
        last = latest_point.get(symbol)
        if last is None or last.as_of.date() not in returns:
            continue
        day = last.as_of.date()
        if session is None or day > session:
            session = day
    if session is None:
        return TopicMoveResult(skipped_reason="no member has a one-day move to measure")
    for symbol, returns in daily.items():
        last = latest_point.get(symbol)
        if last is not None and last.as_of.date() == session and session in returns:
            session_moves[symbol] = returns[session]

    required = max(TOPIC_MIN_MEMBERS, math.ceil(confirmed * TOPIC_MIN_COVERAGE))
    moved = len(session_moves)
    if moved < required:
        return TopicMoveResult(
            skipped_reason=(
                f"{moved} of {confirmed} instruments priced on {session.isoformat()}; "
                f"at least {required} needed"
            )
        )

    basket = math.fsum(session_moves.values()) / moved
    if abs(basket) < thresholds.sigma_min_move:
        return TopicMoveResult()

    sample = _basket_history(daily, session, required, thresholds)
    if len(sample) < thresholds.sigma_min_observations:
        return TopicMoveResult(
            skipped_reason=(
                f"{len(sample)} prior sessions with enough members priced; "
                f"{thresholds.sigma_min_observations} needed"
            )
        )

    stdev = sample_stdev(sample)
    if stdev is None or stdev == 0.0:
        return TopicMoveResult()
    stdev_used = max(stdev, thresholds.sigma_stdev_floor)
    floor_applied = stdev_used > stdev
    z_score = basket / stdev_used

    severity = severity_for(z_score, thresholds.sigma_move)
    if severity is None:
        return TopicMoveResult()
    if floor_applied:
        severity = cap_severity(severity, FLOORED_SEVERITY_CEILING)

    as_of = max(latest_point[symbol].as_of for symbol in session_moves)
    movers = sorted(session_moves.items(), key=lambda item: (-abs(item[1]), item[0]))
    advancers = sum(1 for value in session_moves.values() if value > 0)
    decliners = sum(1 for value in session_moves.values() if value < 0)

    return TopicMoveResult(
        findings=[
            Finding(
                kind="topic_move",
                severity=severity,
                subject_ref=f"topic:{topic_id}",
                as_of=as_of,
                evidence={
                    "topic_id": topic_id,
                    "topic_label": label,
                    "as_of": as_of.isoformat(),
                    "session": session.isoformat(),
                    "basket_change_pct": basket,
                    "equal_weighted": True,
                    "members": confirmed,
                    "members_moved": moved,
                    "advancers": advancers,
                    "decliners": decliners,
                    "unchanged": moved - advancers - decliners,
                    "movers": [
                        {"symbol": symbol, "change_pct": change}
                        for symbol, change in movers[:TOPIC_MOVERS_SHOWN]
                    ],
                    "not_priced_on_session": sorted(
                        member.symbol for member in members if member.symbol not in session_moves
                    ),
                    "z_score": z_score,
                    "return_stdev": stdev,
                    "return_stdev_used": stdev_used,
                    "return_stdev_floor": thresholds.sigma_stdev_floor,
                    "return_stdev_floor_applied": floor_applied,
                    "sample_size": len(sample),
                    "window_days": thresholds.sigma_window_days,
                    "min_move_pct": thresholds.sigma_min_move,
                    "thresholds_sigma": thresholds.sigma_move.as_evidence(),
                },
            )
        ]
    )


def _basket_history(
    daily: Mapping[str, Mapping[date, float]],
    session: date,
    required: int,
    thresholds: AnalysisThresholds,
) -> list[float]:
    """The basket's daily moves in the window before `session`, oldest first.

    Today is excluded for the reason `sigma_move.py` gives first: a shock inside
    its own denominator reports itself as smaller than it is. A day on which fewer
    than `required` members were priced is left out rather than averaged over the
    few that were, so every sample point is the same kind of basket as the move
    it is compared with.
    """
    earliest = session - timedelta(days=thresholds.sigma_window_days)
    by_day: dict[date, list[float]] = {}
    for returns in daily.values():
        for day, value in returns.items():
            if earliest <= day < session:
                by_day.setdefault(day, []).append(value)
    return [
        math.fsum(values) / len(values)
        for day, values in sorted(by_day.items())
        if len(values) >= required
    ]
