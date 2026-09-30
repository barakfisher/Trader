"""Is a symbol in the screened universe? Asked when a user names a symbol (M8).

A symbol the user can price but the universe does not hold is a gap the admin
panel reports: it will never be offered for a topic. The screen's rules live in
`snapshot.py`; this module only answers whether a profile exists and, if not,
which of those rules explains it.
"""

from __future__ import annotations

from typing import Protocol

from sqlalchemy import text

from app.core.logging import get_logger
from app.db import get_engine
from app.models import Instrument, InstrumentUniverse
from app.universe.snapshot import screen_exclusion

log = get_logger("universe.membership")


class UniverseMembership(Protocol):
    def contains(self, symbol: str) -> bool | None:
        """Whether the universe holds a profile for `symbol`; None when there is
        no universe to ask. May raise."""
        ...


class DatabaseMembership:
    """Membership as the database holds it: a *screened* profile for the symbol.

    An on-demand profile does not make a member. It describes the listing, but
    no topic will ever be answered from it, so the gap it was fetched for is
    still a gap - one only a rescreen can close - and stays reported.

    An installation with no profiles at all - a fresh clone, whose descriptions
    are never committed - has no universe to be missing from. Without the
    second EXISTS, every symbol anyone named there would be reported as a gap.
    """

    def contains(self, symbol: str) -> bool | None:
        with get_engine().connect() as connection:
            row = connection.execute(
                text(
                    "SELECT EXISTS (SELECT 1 FROM instrument_profiles p "
                    "JOIN instruments i ON i.id = p.instrument_id "
                    "WHERE i.symbol = :symbol AND p.membership = 'screened') AS member, "
                    "EXISTS (SELECT 1 FROM instrument_profiles WHERE membership = 'screened') "
                    "AS loaded"
                ),
                {"symbol": symbol},
            ).one()
        return bool(row.member) if row.loaded else None


def universe_status(
    instrument: Instrument | None, membership: UniverseMembership
) -> InstrumentUniverse | None:
    """The universe's answer for a resolved instrument; None when it cannot be given.

    A failed lookup is None, never `member: false`: reporting an unreachable
    database as a gap would fill the admin panel with gaps that are not there.
    """
    if instrument is None:
        return None
    try:
        member = membership.contains(instrument.symbol)
    except Exception as error:  # noqa: BLE001 - any failure means "not checked"
        log.warning("universe.membership_unavailable", symbol=instrument.symbol, error=str(error))
        return None
    if member is None:
        return None
    if member:
        return InstrumentUniverse(member=True)
    return InstrumentUniverse(
        member=False, outside_screen=screen_exclusion(instrument.asset_class, instrument.exchange)
    )
