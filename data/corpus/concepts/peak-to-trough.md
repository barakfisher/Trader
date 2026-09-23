---
slug: peak-to-trough
title: Peak-to-trough
source: traders-curated
license: CC0-1.0
---

## What it is

Peak-to-trough describes a complete decline: from the highest point of an
episode down to its lowest, before any recovery began. It is the shape a
drawdown has once it is over.

It appears here alongside drawdown because the two are easy to conflate and
mean different things. A drawdown is measured from a peak to *now*. A
peak-to-trough span is measured from a peak to the bottom - and the bottom is
only identifiable afterwards.

## How it is computed

    peak-to-trough = (trough price - peak price) / peak price

The peak is the highest price before the decline; the trough is the lowest price
reached before the instrument turned back up. Both are specific days with
specific prices, and the span between them has a duration as well as a depth,
which is usually as informative as the percentage.

**What this system actually reports is peak-to-latest, not peak-to-trough.** The
drawdown rule compares the trailing high against the most recent close. If the
instrument is still falling, the latest price is not the trough and the figure
will deepen. If it has already turned and is recovering, the latest price is
above the trough and the true peak-to-trough span was larger than the number
shown. The two coincide only on the exact day the bottom is set, and nothing can
identify that day at the time.

This is a limit of measuring in the present, not a shortcoming of the
arithmetic. A trough is defined by what comes after it.

## How to read it

Read a peak-to-trough figure as history and a drawdown figure as a current
position. Historical peak-to-trough spans for an instrument or an index are
useful for calibration - they say how deep declines in this thing have gone
before - and they say nothing about whether the present one is near its end.

Duration matters alongside depth. A 20% fall over three days and a 20% fall over
eleven months are different events with different causes, and the single
percentage hides which one occurred. The dates behind the prices are carried in
this system's evidence for that reason.

## Common misreadings

**Calling the current low "the trough".** Every decline looks like it has
bottomed until it does not. The word trough is a claim about the future that the
data cannot yet support, which is why this system says "below its recent high"
rather than naming a bottom.

**Comparing spans measured over different windows.** A peak-to-trough taken from
a thirty-day lookback and one taken from ten years of history are not the same
measurement. The lookback determines which peak is found, and a longer window
will usually find a higher one and therefore a deeper decline.

**Averaging depth and duration away.** "The typical peak-to-trough is 15%" is a
summary of episodes that ranged from brief to years long. The average describes
none of them, and the tail is where the consequences live.
