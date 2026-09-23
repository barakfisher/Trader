---
slug: volatility
title: Volatility
source: traders-curated
license: CC0-1.0
---

## What it is

Volatility is how much an instrument's price moves around, day to day, without
regard to which direction it moves in. It is the answer to "is this a quiet
holding or a jumpy one", and it is what makes the same 3% move an event in one
instrument and an ordinary Tuesday in another.

In this system, volatility is not a separate measurement. It is the standard
deviation of an instrument's recent daily returns, and it appears as the
denominator of every z-score reported here.

## How it is computed

Take the daily returns from a rolling window of recent trading, and compute
their standard deviation. That number is the volatility: the typical distance
of a day's return from the average day.

Three properties of the estimate matter more than the arithmetic:

**The window is recent and short.** It is drawn from about thirty calendar days,
which is roughly twenty-one trading days. That is deliberate. Volatility is not
a fixed property of an instrument - it rises and falls with conditions - so the
estimate is meant to describe the instrument's *current* regime rather than its
history.

**A minimum number of returns is required.** Below about ten observations the
standard deviation is an anecdote rather than an estimate, and this system emits
nothing at all rather than a confident-looking number. A newly added holding
therefore produces no volatility-based findings for its first couple of weeks.

**There is a floor under it.** An instrument that moves five hundredths of a
percent a day would turn a 1% move into a twenty-sigma event: arithmetic, not
information. So the denominator is never allowed below a quarter of a percent a
day. When that floor is what gets used, the resulting z-score is a *bound*
rather than a measurement, and this system says so in the explanation and
refuses to let the finding claim its highest severity.

## How to read it

Volatility describes the width of the recent distribution, not the direction of
anything. A high-volatility instrument is not one that is falling; it is one
that is moving. Rising volatility often accompanies falling prices, but that is
a tendency of markets, not a fact contained in the number.

It is also a statement about one instrument measured against itself over time.
Comparing two instruments' volatilities is meaningful; comparing either to a
threshold in percent is what this system avoids, and is the reason the z-score
exists.

## Common misreadings

**Treating it as risk.** Volatility is one component of risk and not the whole
of it. An instrument can be perfectly steady and still be a bad thing to own,
and a volatile holding sized appropriately may carry less risk of real loss than
a quiet one that is too large a share of the portfolio.

**Reading a fall in volatility as safety.** A calm stretch shortens the ruler.
The same absolute move then produces a larger z-score than it did a month
earlier, and this system will describe it as more unusual - because against the
instrument's recent behaviour, it is. The instrument did not become more
dangerous; the comparison changed.

**Expecting it to predict.** It says what has recently been typical. Quiet
periods are followed by loud ones with no warning in this number, and the
fattest market moves on record all happened while the trailing estimate was low.
