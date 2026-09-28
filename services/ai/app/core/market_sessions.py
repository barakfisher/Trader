"""When each exchange's regular session runs, in its own local time.

Before this module every symbol was judged against New York hours, because the
quote request carried bare symbols and the service could not know where one
traded. SAP.DE trades on XETRA, 09:00-17:30 in Frankfurt: judged by New York it
was "closed" for its whole morning and "open" for two hours after its own
close, so its quotes were cached for an hour while they moved and re-read every
fifteen minutes while they could not.

Two naming systems reach this table, and both are keys. Instruments added as
holdings carry display names (`NASDAQ`, `NYSE`, `XETRA`); the universe carries
Yahoo's exchange codes (`NMS`, `NYQ`, `PCX`, `GER`). Both were read from the
database, not assumed.

Only the regular continuous session is modelled. Auctions, lunch breaks and
holidays are ignored for the reason `cache_policy.is_us_market_open` gives: the
whole cost of being wrong is a few extra requests that return an unchanged
price, and a calendar that must be maintained by hand rots every January.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Session:
    """A regular trading session: local timezone and [open, close) in local minutes."""

    timezone: str
    open_minute: int
    close_minute: int


def _at(hour: int, minute: int = 0) -> int:
    return hour * 60 + minute


US = Session("America/New_York", _at(9, 30), _at(16))
FRANKFURT = Session("Europe/Berlin", _at(9), _at(17, 30))
LONDON = Session("Europe/London", _at(8), _at(16, 30))
EURONEXT = Session("Europe/Paris", _at(9), _at(17, 30))
ZURICH = Session("Europe/Zurich", _at(9), _at(17, 30))
TORONTO = Session("America/Toronto", _at(9, 30), _at(16))
TOKYO = Session("Asia/Tokyo", _at(9), _at(15, 30))
HONG_KONG = Session("Asia/Hong_Kong", _at(9, 30), _at(16))

#: Exchange name or code -> session, upper-case. Display names and Yahoo codes.
_SESSIONS: dict[str, Session] = {
    **dict.fromkeys(
        (
            "NASDAQ", "NYSE", "NYSEARCA", "NYSEAMERICAN", "AMEX", "BATS", "CBOE",
            "NMS", "NGM", "NCM", "NYQ", "PCX", "ASE", "BTS",
        ),
        US,
    ),
    **dict.fromkeys(("XETRA", "GER", "FRA", "FRANKFURT"), FRANKFURT),
    **dict.fromkeys(("LSE", "LON"), LONDON),
    **dict.fromkeys(("EURONEXT", "PAR", "AMS", "BRU"), EURONEXT),
    **dict.fromkeys(("SIX", "EBS"), ZURICH),
    **dict.fromkeys(("TSX", "TOR"), TORONTO),
    **dict.fromkeys(("TSE", "JPX", "TYO"), TOKYO),
    **dict.fromkeys(("HKEX", "HKG"), HONG_KONG),
}  # fmt: skip


def session_for(exchange: str | None) -> Session:
    """The session for `exchange`, or the US session when it is unknown.

    US because it is what every symbol was judged by before this table existed,
    and nearly every instrument here trades there: an unknown exchange keeps
    exactly the old behaviour rather than inventing a new one.
    """
    if exchange is None:
        return US
    return _SESSIONS.get(exchange.strip().upper(), US)
