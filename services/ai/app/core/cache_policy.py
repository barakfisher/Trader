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

This is a pure function of (symbol, provider delay, clock) so it can be tested
against a fake clock rather than against whatever time CI happens to run at.
"""

from __future__ import annotations

from datetime import UTC, datetime

#: Crypto never closes, so the only thing bounding its TTL is how often we are
#: willing to ask.
CRYPTO_TTL_SECONDS = 60

#: Floor applied when the caller does not pass one. Mirrors the CACHE_TTL_QUOTE
#: default so importing this module standalone behaves like the wired service.
DEFAULT_MINIMUM_TTL_SECONDS = 60

#: Used when the market is closed. An open price cannot change before the bell,
#: so the only cost of a longer TTL is staleness across the open; an hour caps
#: that without turning the overnight window into a per-minute poll.
CLOSED_TTL_SECONDS = 3600

#: Regular US session expressed in UTC, which is what the fixed window below
#: assumes: 09:30-16:00 in New York is 13:30-20:00 UTC while US daylight saving
#: is in force (mid-March to early November) and 14:30-21:00 UTC outside it.
#: We keep the summer window year-round rather than carrying a timezone lookup
#: here. In the winter months that mistakes 13:30-14:30 UTC for open - harmless,
#: a shorter TTL and a few extra fetches before the bell - and 20:00-21:00 UTC
#: for closed, which is the one real cost: during the last hour of a winter
#: session a quote can sit up to an hour stale. Fixing it properly means
#: resolving America/New_York here; deferred until the UI cares.
MARKET_OPEN_MINUTE_UTC = 13 * 60 + 30
MARKET_CLOSE_MINUTE_UTC = 20 * 60

#: Quote currencies that appear as a suffix on continuously traded pairs.
_CRYPTO_QUOTE_SUFFIXES = ("-USD", "-USDT", "-USDC", "-EUR", "-GBP", "-BTC", "-ETH")


def is_crypto_symbol(symbol: str) -> bool:
    """Heuristic: does this symbol look like a 24/7 traded pair?

    HEURISTIC, knowingly. The correct discriminator is the instrument's
    asset_class, which the AI service does not receive - `POST /market/quotes`
    carries bare symbol strings. Threading asset_class through would change the
    wire contract and the generated TypeScript client, which is not worth it for
    a TTL decision, so we read the shape the providers already use: yfinance and
    CoinGecko both spell crypto as PAIR-QUOTE ("BTC-USD", "ETH-EUR").

    Being wrong is cheap in one direction and not the other. A misclassified
    equity gets a 60-second TTL: more fetches, still correct. A crypto pair
    missing its suffix gets an equity TTL and can go an hour stale overnight -
    so the suffix list covers the quote currencies our providers actually emit.
    """
    return symbol.strip().upper().endswith(_CRYPTO_QUOTE_SUFFIXES)


def is_us_market_open(now: datetime) -> bool:
    """Is the regular US session running at `now`?

    Public holidays are deliberately ignored. A holiday calendar is either a new
    dependency or a hand-maintained table that silently rots every January, and
    the entire consequence of being wrong on Thanksgiving is that we use the
    in-hours TTL and make a handful of extra requests that return yesterday's
    close. Weekends are worth handling because they are a seventh of the year
    and need no data to compute.
    """
    moment = now.astimezone(UTC)
    if moment.weekday() >= 5:  # Saturday, Sunday
        return False
    minute_of_day = moment.hour * 60 + moment.minute
    return MARKET_OPEN_MINUTE_UTC <= minute_of_day < MARKET_CLOSE_MINUTE_UTC


def quote_ttl(
    symbol: str,
    provider_delay_seconds: int,
    now: datetime | None = None,
    *,
    minimum_ttl_seconds: int = DEFAULT_MINIMUM_TTL_SECONDS,
) -> int:
    """Seconds to cache a quote for `symbol` served by a provider with that delay.

    `minimum_ttl_seconds` is the CACHE_TTL_QUOTE floor: it protects against a
    provider that under-declares its delay (or declares 0) turning the hot path
    into an unbounded poll. `now` defaults to the current UTC time but is
    injectable so tests do not depend on when they run.
    """
    moment = now or datetime.now(UTC)
    floor = max(minimum_ttl_seconds, 0)

    if is_crypto_symbol(symbol):
        # Crypto ignores the provider delay: the exchanges are continuous, and a
        # 15-minute-delayed crypto feed is still worth re-reading every minute
        # because the delayed value itself keeps moving.
        return max(CRYPTO_TTL_SECONDS, floor)

    if is_us_market_open(moment):
        return max(provider_delay_seconds, floor)
    return max(CLOSED_TTL_SECONDS, floor)
