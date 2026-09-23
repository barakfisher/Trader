---
slug: drawdown
title: Drawdown
source: traders-curated
license: CC0-1.0
---

## What it is

A drawdown is how far an instrument has fallen from a recent high. Where the
daily-move rules ask "what happened today", drawdown asks a slower question:
where does this holding stand relative to its recent best?

That question needs asking separately because a position can slide eighteen
percent over six weeks without ever having a three percent day. Nothing else in
this system would say a word about it.

## How it is computed

Find the highest price inside a lookback window, then compare the latest price
against it:

    drawdown = (latest price - high price) / high price

The result is negative by construction, because the high is the maximum and the
latest price is not it. A fall from 120 to 102 is a drawdown of -15%.

The high is a **local** high, taken from roughly the last thirty days, not an
all-time high. This keeps the finding about the current episode rather than
about a peak two years ago that no longer describes anything.

This system refuses to report a drawdown in three cases: when there are fewer
than about five prices inside the window, because the "high" is then usually
just whichever price we happen to hold first; when the window's prices are not
all in one currency, because the maximum of a EUR price and a USD price is not
a price; and when the high *is* the latest point, which is a drawdown of zero
and no news.

## How to read it

A drawdown is a statement about distance from a peak, not about loss. It says
nothing about what you paid. A holding you bought below the current price can
show a large drawdown while you remain ahead on the position.

The size that matters is relative to the instrument. A 12% drawdown in a broad
index fund is a different event from a 12% drawdown in a single volatile
company, and the recent high it is measured from is itself just one day's price.
This system reports the high and the date it was observed alongside the
percentage, so the comparison can be checked rather than taken on trust.

## Common misreadings

**Reading the recovery as symmetric.** A 20% fall needs a 25% rise to get back,
and a 50% fall needs 100%. The arithmetic is not intuitive and it is the single
most consequential thing about drawdowns: the percentage that describes the fall
is always smaller than the percentage required to undo it.

**Treating it as a finished episode.** The measurement compares the peak to the
*latest* price, which is wherever the instrument happens to be right now. It is
not a completed peak-to-trough span, and the decline may deepen tomorrow.

**Assuming a peak was a fair price.** A single spuriously high print raises the
apparent high and inflates every subsequent drawdown. This system does not
smooth the series - a real peak followed by a real slide is exactly what it
exists to report - so it names the high price and its date instead, which makes
a bad one recognisable rather than buried inside a percentage.
