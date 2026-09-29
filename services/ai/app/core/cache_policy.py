"""How long a cached quote stays fresh.

A flat quote TTL is wrong in both directions. `YFinanceProvider.delay_seconds`
is 900: Yahoo republishes a delayed price every 15 minutes, so a 60-second TTL
sends 15 requests per quarter-hour and 14 of them return a value we already
held. And with US markets closed, a price cannot change at all - refetching
AAPL every minute at 03:00 spends quota to re-read a number that is fixed until
the next open. Provider quotas are the scarcest resource in this system, so the
TTL follows the data instead of the clock:

  * crypto: 60s - it really does trade continuously;
  * equities during market hours: the provider's own delay, floored by the
    configured minimum, because nothing new exists before then;
  * equities outside market hours: one hour, short enough that the first
    request after the opening bell is at most an hour stale and the normal
    in-hours path then takes over.

"Market hours" are the instrument's own exchange's (`market_sessions.py`), and
"crypto" is its asset class, whenever the caller sends them - the orchestrator
does, from the instruments table. A bare symbol falls back to the old guesses: US
hours, and a pair-shaped suffix for crypto.

This is a pure function of (symbol, market, provider delay, clock) so it can be
tested against a fake clock rather than against whatever time CI happens to run at.
"""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.core.logging import get_logger
from app.core.market_sessions import US, Session, session_for

#: Crypto never closes, so nothing bounds its TTL except how often we are
#: willing to ask - which makes it by far the most expensive symbol class we
#: serve. At 60 seconds a single pair left open on the dashboard costs ~1,440
#: requests a day, more than seventeen equities combined.
#:
#: Five minutes is the tracker's answer rather than the trading desk's. This
#: product reports what a portfolio is worth and explains why it moved; a
#: five-minute-old bitcoin price changes a displayed total by a fraction of a
#: percent and changes no explanation at all. Revisit if a feature ever needs
#: minute-level crypto, and pay for it deliberately.
CRYPTO_TTL_SECONDS = 300

#: Floor applied when the caller does not pass one. Mirrors the CACHE_TTL_QUOTE
#: default so importing this module standalone behaves like the wired service.
DEFAULT_MINIMUM_TTL_SECONDS = 60

#: Used when the market is closed. An open price cannot change before the bell,
#: so the only cost of a longer TTL is staleness across the open; an hour caps
#: that without turning the overnight window into a per-minute poll.
CLOSED_TTL_SECONDS = 3600

#: Fallback window for the US session, in UTC, used only if the system has no
#: timezone database. Correct for roughly eight months of the year: the session is
#: 13:30-20:00 UTC under US daylight saving and 14:30-21:00 UTC outside it, which
#: is why sessions are resolved in their own zone everywhere else.
FALLBACK_OPEN_MINUTE_UTC = 13 * 60 + 30
FALLBACK_CLOSE_MINUTE_UTC = 20 * 60

log = get_logger("cache_policy")

#: Quote currencies that appear as a suffix on continuously traded pairs.
_CRYPTO_QUOTE_SUFFIXES = ("-USD", "-USDT", "-USDC", "-EUR", "-GBP", "-BTC", "-ETH")


def is_crypto_symbol(symbol: str) -> bool:
    """Heuristic: does this symbol look like a 24/7 traded pair?

    The FALLBACK, used only when the caller did not send an asset class
    (`is_continuous`). It reads the shape the providers already use: yfinance
    and CoinGecko both spell crypto as PAIR-QUOTE ("BTC-USD", "ETH-EUR").

    Being wrong is cheap in one direction and not the other. A misclassified
    equity gets a 60-second TTL: more fetches, still correct. A crypto pair
    missing its suffix gets an equity TTL and can go an hour stale overnight -
    so the suffix list covers the quote currencies our providers actually emit.
    """
    return symbol.strip().upper().endswith(_CRYPTO_QUOTE_SUFFIXES)


def is_continuous(symbol: str, asset_class: str | None) -> bool:
    """Does this instrument trade around the clock?

    Its asset class decides when it is known. `unknown` and a missing class fall
    back to the symbol's shape, because that is all a bare lookup has.
    """
    if asset_class is not None and asset_class != "unknown":
        return asset_class == "crypto"
    return is_crypto_symbol(symbol)


def is_us_market_open(now: datetime) -> bool:
    """Is the regular US session running at `now`?"""
    return is_session_open(now, US)


def is_session_open(now: datetime, session: Session) -> bool:
    """Is `session` running at `now`?

    The instant is converted to the exchange's local time, so daylight saving is
    handled by the timezone database rather than by us remembering to move a
    constant twice a year - and Europe and the US move theirs on different
    weekends.

    Public holidays are deliberately ignored. A holiday calendar is either a new
    dependency or a hand-maintained table that silently rots every January, and
    the entire consequence of being wrong on Thanksgiving is that we use the
    in-hours TTL and make a handful of extra requests that return yesterday's
    close. Weekends are worth handling because they are a seventh of the year
    and need no data to compute.
    """
    try:
        local = now.astimezone(ZoneInfo(session.timezone))
        open_minute, close_minute = session.open_minute, session.close_minute
    except ZoneInfoNotFoundError:
        # A container without tzdata should degrade to extra fetches, never to a
        # crash on the path that prices every portfolio.
        log.warning("cache_policy.timezone_unavailable", timezone=session.timezone)
        if session != US:
            # No known UTC window for other sessions: call it open, which costs
            # extra fetches and never an hour-stale price.
            return True
        local = now.astimezone(UTC)
        open_minute, close_minute = FALLBACK_OPEN_MINUTE_UTC, FALLBACK_CLOSE_MINUTE_UTC

    if local.weekday() >= 5:  # Saturday, Sunday - in market-local terms
        return False
    minute_of_day = local.hour * 60 + local.minute
    return open_minute <= minute_of_day < close_minute


def quote_ttl(
    symbol: str,
    provider_delay_seconds: int,
    now: datetime | None = None,
    *,
    minimum_ttl_seconds: int = DEFAULT_MINIMUM_TTL_SECONDS,
    asset_class: str | None = None,
    exchange: str | None = None,
) -> int:
    """Seconds to cache a quote for `symbol` served by a provider with that delay.

    `asset_class` and `exchange` are the instrument's, when the caller knows
    them; without them the symbol is judged by its shape and by US hours.

    `minimum_ttl_seconds` is the CACHE_TTL_QUOTE floor: it protects against a
    provider that under-declares its delay (or declares 0) turning the hot path
    into an unbounded poll. `now` defaults to the current UTC time but is
    injectable so tests do not depend on when they run.
    """
    moment = now or datetime.now(UTC)
    floor = max(minimum_ttl_seconds, 0)

    if is_continuous(symbol, asset_class):
        # Crypto ignores the provider delay: the exchanges are continuous, and a
        # 15-minute-delayed crypto feed is still worth re-reading every minute
        # because the delayed value itself keeps moving.
        return max(CRYPTO_TTL_SECONDS, floor)

    if is_session_open(moment, session_for(exchange)):
        return max(provider_delay_seconds, floor)
    return max(CLOSED_TTL_SECONDS, floor)
