---
slug: daily-return
title: Daily return
source: traders-curated
license: CC0-1.0
---

## What it is

A daily return is how much an instrument's price changed over one trading day,
expressed as a fraction of where it started. It is the smallest unit of "what
happened" that this system reports on, and every other price statistic here is
built out of a series of them.

## How it is computed

Take the most recent close and the close before it:

    daily return = (close today - close yesterday) / close yesterday

A move from 100 to 103 is a return of 0.03, or 3%. The denominator is
yesterday's close, not today's, which is why a 50% fall and a 50% rise do not
cancel out.

This system measures the return between two *closing* prices from the same
provider. It never stitches one provider's close to another's, because two
providers can disagree about what "the close" means - one may include after-hours
trading and another may not - and a return measured across that seam describes
the disagreement rather than the market.

## How to read it

A daily return is a fact about one day, not a trend. Read it against what is
normal for that particular instrument: 3% is an ordinary day for a volatile
small company and a significant one for a broad index fund. That comparison is
what the z-score exists to make.

## Common misreadings

**Adding returns across days.** Returns compound, they do not add. Three days of
+10% is +33.1%, not +30%.

**Reading a large return as news.** A price can move several percent on no news
at all. The move is the observation; the explanation is a separate question, and
is often that there is no single reason.

**Confusing it with profit.** A daily return describes the price, not your
position. What you made depends on what you paid, which is a different number.
