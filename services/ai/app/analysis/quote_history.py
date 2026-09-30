"""Reading price history out of `quotes`, and nothing else.

This is the only module in `app/analysis` that touches the database, and it is
the whole of the purity boundary: it contains no arithmetic and no thresholds, and
the rules contain no SQL and no connection. A rule can therefore be tested with a
literal list of prices, and this loader can be integration-tested against a real
table, with no overlap between the two.

Every statement in the package lives here, spelled out as a module constant so
`grep quotes` finds all of them at once. SQLAlchemy Core with bound parameters,
never string interpolation.

The caller supplies the connection. This module never opens one and never reads
`get_engine()` itself, so a run holds one connection for all of its symbols
instead of one per symbol, and a test can hand in whatever it likes.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import bindparam, text

from app.analysis.price_series import PricePoint, normalise

#: Ascending by `as_of`, which is the order every rule expects, and the order the
#: `quotes(instrument_id, as_of desc)` index can serve backwards.
SQL_PRICE_SERIES = text(
    """
    SELECT as_of, price_minor, currency
      FROM quotes
     WHERE instrument_id = :instrument_id
       AND as_of >= :since
       AND NOT (source = ANY(:excluded_sources))
     ORDER BY as_of
    """
)

#: Same, bounded above. A scheduled run that re-derives an earlier bucket must not
#: see prices that did not exist yet, or a re-run of yesterday's analysis would
#: produce different findings from the original - and runs are required to be
#: idempotent (guideline 8).
SQL_PRICE_SERIES_UNTIL = text(
    """
    SELECT as_of, price_minor, currency
      FROM quotes
     WHERE instrument_id = :instrument_id
       AND as_of >= :since
       AND as_of <= :until
       AND NOT (source = ANY(:excluded_sources))
     ORDER BY as_of
    """
)

#: One row per instrument: the latest observation we hold. `DISTINCT ON` with a
#: matching `ORDER BY` is the index-friendly spelling; a correlated subquery over
#: a few dozen instruments is not.
SQL_LATEST_QUOTES = text(
    """
    SELECT DISTINCT ON (instrument_id)
           instrument_id, as_of, price_minor, currency
      FROM quotes
     WHERE instrument_id IN :instrument_ids
     ORDER BY instrument_id, as_of DESC
    """
).bindparams(bindparam("instrument_ids", expanding=True))


def load_price_series(
    connection: object,
    instrument_id: UUID | str,
    *,
    since: datetime,
    until: datetime | None = None,
    excluded_sources: Sequence[str] = (),
) -> list[PricePoint]:
    """Price history for one instrument, oldest first.

    `since` and `until` are compared against `as_of`, which is when the price was
    *observed* rather than when it was fetched, so a window here means a window of
    market time. Rows can share an `as_of` only if a caller merges series;
    `normalise` in `price_series.py` collapses those.

    `connection` is typed loosely so that a unit test can pass a stub: the only
    thing required of it is `execute(statement, parameters)`.
    """
    statement = SQL_PRICE_SERIES if until is None else SQL_PRICE_SERIES_UNTIL
    # `excluded_sources` is how a real installation ignores fixture prices that
    # an earlier fallback stored (see providers/price_provenance.py).
    parameters: dict[str, object] = {
        "instrument_id": str(instrument_id),
        "since": since,
        "excluded_sources": list(excluded_sources),
    }
    if until is not None:
        parameters["until"] = until
    rows = connection.execute(statement, parameters)  # type: ignore[attr-defined]
    return [
        PricePoint(as_of=row.as_of, price_minor=row.price_minor, currency=row.currency)
        for row in rows
    ]


def load_latest_quotes(
    connection: object,
    instrument_ids: list[UUID | str],
) -> dict[str, PricePoint]:
    """The most recent observation per instrument, keyed by instrument id as a string.

    An instrument with no rows is absent from the result rather than present with a
    zero: an unpriced holding has to stay recognisable as unpriced all the way to
    the caller (guideline 7).
    """
    if not instrument_ids:
        # An empty `IN ()` is a syntax error in Postgres, and asking for nothing
        # is a legitimate thing for a caller with no holdings to do.
        return {}
    rows = connection.execute(  # type: ignore[attr-defined]
        SQL_LATEST_QUOTES,
        {"instrument_ids": [str(item) for item in instrument_ids]},
    )
    return {
        str(row.instrument_id): PricePoint(
            as_of=row.as_of, price_minor=row.price_minor, currency=row.currency
        )
        for row in rows
    }


def load_daily_closes(
    connection: object,
    instrument_id: UUID | str,
    *,
    days: int,
    now: datetime,
    excluded_sources: Sequence[str] = (),
) -> list[PricePoint]:
    """One close per UTC day over the last `days`, oldest first - the series the rules see.

    `load_price_series` and `normalise` composed, and nothing added: this is what
    a chart of a holding draws, so that the line a reader looks at and the prices
    a finding was computed from are one series by construction rather than two
    that are meant to agree. Bounded above by `now` as well, so a row dated in the
    future (see `backfill.py`) is never drawn as today.
    """
    return normalise(
        load_price_series(
            connection,
            instrument_id,
            since=now - timedelta(days=days),
            until=now,
            excluded_sources=excluded_sources,
        )
    )
