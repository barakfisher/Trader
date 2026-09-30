"""A record of each universe load, for the admin page to reconcile against (M8).

The loader knows why the database and the snapshot files differ - it is the
one that skipped each row, for a reason it could name. This writes those
reasons down beside the manifest it read, so the page compares numbers against
the loader's own account of them instead of re-deriving it (decision 86).
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.universe.profiles import HoldingsReport, LoadReport


def load_record(
    *,
    members: int,
    holding_rows: int,
    report: LoadReport,
    holdings: HoldingsReport,
) -> dict[str, int]:
    """The loader's counts, named for the reconciliation they support.

    `members = profiled + undescribed + no_currency` - where `profiled` is
    created + text_changed + unchanged - and `holding_rows = stored +
    implausible + of_unprofiled_etf`. The admin page checks both sums and
    flags any remainder as unexplained.
    """
    return {
        "members": members,
        "profiled": report.created + report.text_changed + report.unchanged,
        "created": report.created,
        "text_changed": report.text_changed,
        "unchanged": report.unchanged,
        "undescribed": report.undescribed,
        "no_currency": report.no_currency,
        "holding_rows": holding_rows,
        "holdings_stored": holdings.total,
        "holdings_matched_by_symbol": holdings.matched_by_symbol,
        "holdings_matched_by_name": holdings.matched_by_name,
        "holdings_unmatched": holdings.unmatched,
        "holdings_implausible": holdings.implausible,
        "holdings_of_unprofiled_etf": holdings.of_unprofiled_etf,
    }


def record_load(
    connection: Connection,
    *,
    snapshot_as_of: str,
    source: str,
    manifest: dict[str, Any],
    record: dict[str, int],
) -> None:
    connection.execute(
        text(
            "INSERT INTO universe_loads (snapshot_as_of, source, manifest, report) "
            "VALUES (:as_of, :source, CAST(:manifest AS jsonb), CAST(:report AS jsonb))"
        ),
        {
            "as_of": datetime.fromisoformat(snapshot_as_of.replace("Z", "+00:00")),
            "source": source,
            "manifest": json.dumps(manifest),
            "report": json.dumps(record),
        },
    )
