"""Fill the price history the rules read.

The analysis engine needs a series before it can say anything - ten observations
for a sigma move, five for a drawdown - and a spot quote contributes at most one
observation a day. Without this, a real portfolio would wait a fortnight for its
first finding, and only on days someone opened the dashboard.

Writes are idempotent: `quotes` is keyed `(instrument_id, as_of)` and a daily
close is dated to the session close, so re-running a backfill changes nothing
and re-running it tomorrow adds one row per instrument. That makes it safe to
run on a schedule, after an import, or by hand when something looks thin.

**A provider's daily history includes the day still trading.** Yahoo returns
today's candle while the session is open, priced at the latest trade, and every
candle is dated to 20:00 UTC. Until 2026-09-30 the backfill stored it with
`DO NOTHING`, so the price at run time became that day's close for good: AAPL's
16 Sep "close" was an intraday $332.57 (the real close was $332.41), every
crypto close since mid-September was the price at whatever hour the backfill
ran, and a 06:45 UTC run wrote a BTC row dated 20:00 the same evening - a
price observed in the future. Two rules now hold:

  * a close dated after `now` is not stored - its session has not ended, and a
    row dated in the future is an invented observation (guideline 7);
  * a close the backfill wrote earlier is **replaced** by the provider's current
    answer for the same day, because the provider's latest word on a finished
    day is the close. That repairs what an earlier run stored mid-session - a
    crypto day stamped 20:00 is still trading until midnight - on the next run,
    because every run re-reads its whole window. Only the backfill's own rows
    are replaced (same source, `delay_seconds = 0`): a live quote that happens to
    share the 20:00 stamp is an observation, and an observation is never
    rewritten.

**A crypto day ends at midnight UTC, not at its candle's 20:00 stamp.** The
first rule alone stored a ~21:00 BTC price as that day's close on the first
backfill after 20:00 and corrected it the next night - one day on which the
rules read an intraday price as a close. A crypto candle is now final only once
its UTC day is over (`is_final`); an equity's, at its stamp, as before.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from app.core.cache_policy import is_continuous
from app.core.logging import get_logger
from app.models import BackfillInstrument, BackfillResponse
from app.providers.registry import MarketDataService

log = get_logger("analysis.backfill")

_INSERT = text(
    """
    INSERT INTO quotes (instrument_id, as_of, price_minor, currency, source, delay_seconds)
    VALUES (:instrument_id, :as_of, :price_minor, :currency, :source, 0)
    ON CONFLICT (instrument_id, as_of) DO UPDATE
       SET price_minor = EXCLUDED.price_minor,
           currency = EXCLUDED.currency
     WHERE quotes.source = EXCLUDED.source
       AND quotes.delay_seconds = 0
       AND (quotes.price_minor, quotes.currency)
           IS DISTINCT FROM (EXCLUDED.price_minor, EXCLUDED.currency)
    """
)


def is_final(symbol: str, as_of: datetime, now: datetime) -> bool:
    """Has the session behind a daily candle stamped `as_of` ended by `now`?

    A listed instrument's candle is stamped at its close. A crypto candle is
    stamped 20:00 UTC too, but its day runs until the next midnight UTC.
    """
    if is_continuous(symbol, None):
        day_end = datetime.combine(
            as_of.astimezone(UTC).date() + timedelta(days=1), datetime.min.time(), UTC
        )
        return day_end <= now
    return as_of <= now


async def backfill_history(
    connection: object,
    market: MarketDataService,
    instruments: Sequence[BackfillInstrument],
    days: int,
    *,
    now: datetime | None = None,
) -> BackfillResponse:
    """Fetch daily closes for each instrument and store what is new or corrected.

    `written` counts rows inserted *or* corrected; a close already stored at the
    same price is `already_present`. `not_final` counts candles skipped because
    their session had not ended at `now`.
    """
    response = BackfillResponse()
    moment = now or datetime.now(UTC)

    for instrument in instruments:
        fetched = await market.history(instrument.symbol, days)
        closes = [close for close in fetched if is_final(instrument.symbol, close.as_of, moment)]
        response.not_final += len(fetched) - len(closes)
        if not closes:
            response.without_history.append(instrument.symbol.upper())
            continue

        rows = [
            {
                "instrument_id": instrument.instrument_id,
                "as_of": close.as_of,
                "price_minor": close.price_minor,
                "currency": close.currency,
                "source": close.source,
            }
            for close in closes
        ]
        result = connection.execute(_INSERT, rows)  # type: ignore[attr-defined]
        written = result.rowcount if result.rowcount and result.rowcount > 0 else 0
        response.written += written
        response.already_present += len(rows) - written
        response.per_symbol[instrument.symbol.upper()] = written

    log.info(
        "analysis.backfill_complete",
        instruments=len(instruments),
        written=response.written,
        already_present=response.already_present,
        without_history=len(response.without_history),
        not_final=response.not_final,
    )
    return response
