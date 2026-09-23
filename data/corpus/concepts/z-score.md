---
slug: z-score
title: Z-score
source: traders-curated
license: CC0-1.0
---

## What it is

A z-score expresses a single measurement in units of standard deviation from
the average. It converts "the price moved 4%" into "that is a big move *for this
instrument*", which is the comparison that makes one day's return meaningful.

## How it is computed

    z = (this return - average return) / standard deviation of returns

Both the average and the standard deviation come from a rolling window of recent
daily returns. A z-score of 2 means the move was twice the typical distance from
average; a z-score of -3 means a fall three times the typical distance.

This system reports the size of the z-score regardless of direction, because a
move three standard deviations down is exactly as unusual as one three standard
deviations up.

## How to read it

The z-score is the reason a 2% day in a quiet index fund can be a more notable
event than a 6% day in a volatile small company. It is a statement about how
surprising the move is relative to the instrument's own recent behaviour, not
about how large it is in absolute terms, and not about whether it is good news.

## Common misreadings

**Reading it as a probability.** "Three sigma" implies a specific rarity only if
returns follow a normal distribution, and they do not. Treat a high z-score as
"unusual for this instrument lately", not as odds.

**Trusting it on a short window.** With too few observations, the standard
deviation in the denominator is badly estimated, and a badly estimated
denominator produces a dramatic z-score from an ordinary move.

**Forgetting the window is recent.** After a calm stretch, the standard deviation
falls, and a moderate move produces a large z-score. The instrument did not
become more volatile - the ruler got shorter.
