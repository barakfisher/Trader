"""Load the price-history fixture into the `quotes` table.

A development and demo tool, not a production path. The analysis rules read
price history from `quotes`, and the fixture provider only ever serves a spot
price - so without this, an offline stack has one observation per instrument,
every rule correctly finds nothing, and the whole engine looks broken when it is
merely starved.

    python scripts/seed_price_history.py [--user-id UUID]

The committed fixture carries fixed dates, but they are treated as a *shape*:
the whole series is shifted so its last close lands on yesterday. A fixture with
hardcoded dates silently rots - run it a month later and the "latest move" the
rules look at is a month old, so the planted event stops being the newest step
and the demo quietly shows nothing. Shifting at seed time makes the demo behave
the same on any day.

Idempotent in the sense that conflicting (instrument_id, as_of) rows are
ignored; use --replace to clear previously seeded history first, which is what
you want after regenerating the fixture or on a second day.

Only instruments that already exist are seeded - import the demo portfolio
first. Rows carry source 'fixture-history', so seeded data is never mistaken
for something a provider actually served.
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path

from sqlalchemy import text

from app.core.money import to_minor
from app.db import get_engine

FIXTURES = Path(__file__).resolve().parents[3] / "data" / "fixtures"

#: Daily closes are dated to 20:00 UTC, which is the US close under daylight
#: saving. The exact instant matters less than being consistent and never in the
#: future; the rules reason about ordering and day gaps, not wall-clock time.
CLOSE_TIME = time(20, 0, tzinfo=UTC)

SOURCE = "fixture-history"


def date_shift(fixture_last_day: date, today: date | None = None) -> timedelta:
    """How far to move the series so its last close lands on yesterday."""
    reference = today or datetime.now(UTC).date()
    return (reference - timedelta(days=1)) - fixture_last_day


def rows_for_series(
    instrument_id: str,
    currency: str,
    series: list[dict],
    shift: timedelta = timedelta(0),
) -> list[dict]:
    """Turn one symbol's closes into `quotes` rows. Pure, so it is testable."""
    rows = []
    for point in series:
        day = datetime.fromisoformat(point["date"]).date() + shift
        rows.append(
            {
                "instrument_id": instrument_id,
                "as_of": datetime.combine(day, CLOSE_TIME),
                "price_minor": to_minor(Decimal(point["close"]), currency),
                "currency": currency,
                "source": SOURCE,
                "delay_seconds": 0,
            }
        )
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="report what would be written")
    parser.add_argument(
        "--replace",
        action="store_true",
        help="delete previously seeded history first (source='fixture-history')",
    )
    args = parser.parse_args()

    fixture = json.loads((FIXTURES / "price-history.json").read_text())
    shift = date_shift(date.fromisoformat(fixture["history_ends"]))
    engine = get_engine()

    written = 0
    skipped: list[str] = []
    with engine.begin() as connection:
        if args.replace and not args.dry_run:
            removed = connection.execute(
                text("DELETE FROM quotes WHERE source = :source"), {"source": SOURCE}
            )
            print(f"cleared {removed.rowcount} previously seeded rows")

        known = {
            row.symbol: (str(row.id), row.currency)
            for row in connection.execute(text("SELECT id, symbol, currency FROM instruments"))
        }

        for symbol, series in sorted(fixture["series"].items()):
            if symbol not in known:
                skipped.append(symbol)
                continue
            instrument_id, currency = known[symbol]
            rows = rows_for_series(instrument_id, currency, series, shift)
            if args.dry_run:
                written += len(rows)
                continue
            result = connection.execute(
                text(
                    """
                    INSERT INTO quotes
                        (instrument_id, as_of, price_minor, currency, source, delay_seconds)
                    VALUES
                        (:instrument_id, :as_of, :price_minor, :currency, :source, :delay_seconds)
                    ON CONFLICT (instrument_id, as_of) DO NOTHING
                    """
                ),
                rows,
            )
            written += result.rowcount if result.rowcount and result.rowcount > 0 else 0

    print(
        f"{'would write' if args.dry_run else 'wrote'} {written} quote rows "
        f"(series shifted by {shift.days} days so it ends yesterday)"
    )
    if skipped:
        print(f"skipped (no instrument row yet): {', '.join(skipped)}")
        print("import data/fixtures/demo-portfolio.csv first to create them")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
