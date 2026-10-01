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

**Outside its session, a listed instrument's price is its last close.** A quote
fetched on Sunday carries Friday's price; dated at the fetch it became a Sunday
"close" equal to Friday's - a 0% day for the rules and a flat step on the chart
(measured on compose: 48 equity and ETF rows dated Sunday 27 Sep 2026, one per
dashboard visit). `at_last_close` re-dates such a quote to the close it
actually reports. For a US listing under daylight saving that is 20:00 UTC, the
instant the backfill stores that day's close under, so the two meet on the
primary key; otherwise it is a second row on the same day as the close, which
`normalise` collapses (the last of each UTC day wins). Either way, no weekend.
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.core.cache_policy import is_continuous, is_session_open, last_session_close
from app.core.market_sessions import known_session


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


#: Asset classes with a listed session. Crypto trades continuously; an
#: `unknown` class is not re-dated, since its session cannot be known.
_LISTED = frozenset({"equity", "etf"})


def at_last_close(
    as_of: datetime,
    now: datetime,
    *,
    symbol: str,
    asset_class: str | None,
    exchange: str | None,
) -> datetime:
    """`as_of`, or the session close it really reports when the market is shut.

    Only an equity or ETF whose exchange is known is re-dated: judging an
    unknown exchange by New York hours (as the cache does) would re-date a
    Tokyo stock's live trading to the previous US close. Only a time after the
    last close moves - a provider timestamp at or before it is left as given.
    """
    if asset_class not in _LISTED or is_continuous(symbol, asset_class):
        return as_of
    session = known_session(exchange)
    if session is None or is_session_open(now, session):
        return as_of
    close = last_session_close(now, session)
    if close is None or as_of <= close:
        return as_of
    return close
