---
slug: standard-deviation
title: Standard deviation
source: traders-curated
license: CC0-1.0
---

## What it is

Standard deviation measures how spread out a set of numbers is around their
average. Applied to daily returns, it answers: on a typical day, how far from
average does this instrument move? It is the ruler against which this system
decides whether a particular day was unusual.

## How it is computed

Take the average of the returns, measure how far each return sits from that
average, square those distances, average them, and take the square root. The
squaring is what makes large deviations count for more than small ones, and the
square root puts the answer back into the same units as the returns themselves.

A standard deviation of 0.02 means a typical daily move is about two percent
away from this instrument's average day.

## How to read it

Standard deviation is a description of a sample, not a property of the
instrument. It is computed here over a rolling window of recent returns, so it
describes the instrument's *current* regime rather than its history. A window
that is too short gives an estimate that jumps around; too long, and it averages
together market conditions that no longer apply.

A small sample gives an unreliable number, which is why this system requires a
minimum count of returns in the window before it computes one at all.

## Common misreadings

**Treating it as a forecast.** It says what has recently been typical. It does
not say what tomorrow will be.

**Assuming returns are normally distributed.** Market returns have fatter tails
than the bell curve: moves of four or five standard deviations happen far more
often than the normal distribution predicts. A rare-looking move is less rare
than the arithmetic suggests.

**Comparing it across instruments without context.** A higher standard deviation
is not a defect. It is a description of how much an instrument moves.
