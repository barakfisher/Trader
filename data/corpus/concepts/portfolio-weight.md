---
slug: portfolio-weight
title: Portfolio weight
source: traders-curated
license: CC0-1.0
---

## What it is

A portfolio weight is one holding's share of the whole portfolio, expressed as
a fraction of total value. A weight of 0.25 means that position is a quarter of
everything you own.

It is the unit asset allocation is written in, and the number a drift finding
compares against a target.

## How it is computed

    weight = this position's value / total portfolio value

Both figures are in the portfolio's base currency, and the position's value is
its quantity multiplied by its current price. A holding worth 12,500 USD in a
portfolio worth 50,000 USD has a weight of 0.25.

**Weights are exact, not statistical.** Returns and z-scores elsewhere in this
system are floats, because they are ratios of measurements. A weight is not: it
is a division of two exact quantities, stored in integer minor units, and the
stored target is an exact decimal. A drift of "5.00 percentage points" is a
figure a user will compare against a number they typed, so it is computed with
decimal arithmetic and never rounded through a float on the way.

A targeted instrument that is not held at all has an exact weight of zero. That
is a real drift and it is reported: "you hold none of the 10% you asked for" is
worth saying.

## How to read it

A weight is a ratio, which means it changes when either half changes. Your
position's weight rises when it appreciates and also when everything else
depreciates, and you did nothing in either case. This is the single most
important property of the number and the source of most confusion about it.

Weights are also only as current as the prices behind them. A weight computed
from a stale price is a stale weight, which is why this system dates an
allocation finding by the *oldest* contributing observation rather than the
newest - the shape of the portfolio is only as fresh as its stalest input.

## Common misreadings

**Confusing weight with amount.** Weight is a proportion. Adding money to a
position raises its weight, and adding money to every *other* position lowers
it without your having sold a share. Cash flows into and out of the portfolio
move every weight at once.

**Assuming weights sum to 100% of what you care about.** They sum to 100% of
what is in the portfolio, including holdings you never set a target for. The
*targets* need not sum to anything in particular, and this system reports their
sum rather than assuming it.

**Reading a weight as a decision.** A position being 30% of a portfolio is a
fact about arithmetic. Whether that is too much depends on what the portfolio
is for, which is not a question the number answers.
