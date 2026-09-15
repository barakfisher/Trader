"""When a price was observed.

A quote's `as_of` should answer "when was this price true?", not "when did we
ask?". Getting that wrong is not cosmetic:

  * `quotes` is keyed `(instrument_id, as_of)` so that recording the same
    observation twice is a no-op. Stamping every fetch with `now()` makes that
    key unique every time, so the table accumulates identical prices - we
    measured 60 rows holding 10 distinct prices.
  * Milestone 2 computes moves and volatility from this series. A price that is
    15 minutes old but stamped "now" misdates every move derived from it.

Providers that publish a real trade timestamp should pass it through. Most do
not - Yahoo's `fast_info` has no timestamp field at all - so the fallback is to
floor the fetch time to the provider's freshness window: a 15-minute-delayed
quote read at 14:07 and again at 14:12 is the *same observation*, and both get
`as_of = 14:00`. The stored time is then never more precise than the data
actually is, and the primary key deduplicates for free.
"""

from __future__ import annotations

from datetime import UTC, datetime


def observed_at(now: datetime, granularity_seconds: int) -> datetime:
    """Floor `now` to the start of its window, in UTC, to the second.

    A granularity of 0 or less means the provider's data is continuous and the
    caller wants the instant unchanged.
    """
    moment = now.astimezone(UTC).replace(microsecond=0)
    if granularity_seconds <= 0:
        return moment
    epoch_seconds = int(moment.timestamp())
    return datetime.fromtimestamp(
        epoch_seconds - (epoch_seconds % granularity_seconds),
        tz=UTC,
    )
