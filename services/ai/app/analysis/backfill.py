"""Fill the price history the rules read.

The analysis engine needs a series before it can say anything - ten observations
for a sigma move, five for a drawdown - and a spot quote contributes at most one
observation a day. Without this, a real portfolio would wait a fortnight for its
first finding, and only on days someone opened the dashboard.

Writes are idempotent: `quotes` is keyed `(instrument_id, as_of)` and a daily
close is dated to the session close, so re-running a backfill inserts nothing
and re-running it tomorrow inserts one row per instrument. That makes it safe to
run on a schedule, after an import, or by hand when something looks thin.
"""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import text

from app.core.logging import get_logger
from app.models import BackfillInstrument, BackfillResponse
from app.providers.registry import MarketDataService

log = get_logger("analysis.backfill")

_INSERT = text(
    """
    INSERT INTO quotes (instrument_id, as_of, price_minor, currency, source, delay_seconds)
    VALUES (:instrument_id, :as_of, :price_minor, :currency, :source, 0)
    ON CONFLICT (instrument_id, as_of) DO NOTHING
    """
)


async def backfill_history(
    connection: object,
    market: MarketDataService,
    instruments: Sequence[BackfillInstrument],
    days: int,
) -> BackfillResponse:
    """Fetch daily closes for each instrument and store what is new."""
    response = BackfillResponse()

    for instrument in instruments:
        closes = await market.history(instrument.symbol, days)
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
    )
    return response
