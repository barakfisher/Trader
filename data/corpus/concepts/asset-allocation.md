---
slug: asset-allocation
title: Asset allocation
source: traders-curated
license: CC0-1.0
---

## What it is

Asset allocation is the shape of a portfolio: how the total value is divided
among the things it holds. It is a statement about the whole rather than about
any one position, and it is the only part of a portfolio's behaviour its owner
fully controls.

In this system it is two things compared against each other. The **actual**
allocation is computed from current prices. The **target** allocation is what
the user said they meant to hold, entered on the Targets page. The gap between
them is what produces findings.

## How it is computed

Every holding is valued at its current price, converted into one base currency,
and divided by the portfolio total. That gives each position a weight, and the
set of weights is the allocation.

Two details of how this system does it are worth knowing.

**Conversion happens once, in the valuation step.** A weight is a share of the
whole, so every position must be measured in the same currency before any
comparison is possible. FX conversion belongs to the step that owns the rates
and the single rounding boundary; doing it again later would mean two places
deciding what a EUR holding is worth.

**An incompletely priced portfolio produces no allocation findings at all.** If
even one holding could not be priced, the denominator is smaller than the real
portfolio and every weight computed from it is overstated - a 25% position
looks like 31%, and a drift is invented that does not exist. Reporting those
weights with a "degraded" flag was considered and rejected: this rule's entire
output is a comparison against a number the user chose, and a systematically
wrong comparison is worse than silence.

Targets are not required to cover everything. A user may set them for three of
eight holdings, so the targets need not sum to 100%, and this system does not
renormalise them or infer targets for anything else.

## How to read it

Allocation is about proportion, not about whether any individual holding is
good. A position can be performing well and still be too large a share of the
portfolio - in fact that is the usual way allocations drift, because the things
that rise take up more room.

Drift is reported in **percentage points**, not percent. A holding at 12.7%
against a target of 25% is 12.3 points below target. Writing that as "12.3%
below" would invite exactly the misreading this system cannot afford.

## Common misreadings

**Treating the target as a prediction.** A target allocation is a statement of
intent about how much of each thing you want to own. It is not a forecast, and
drift away from it is not evidence that the target was wrong.

**Reading drift as a verdict on the holding.** The weight is a ratio, so it
moves when *anything* in the portfolio moves. A position's weight can rise
because it gained, or because everything else fell, and the number alone does
not distinguish the two.

**Assuming an untargeted holding is unconstrained.** Every holding is part of
the denominator whether or not it has a target. Adding to something with no
target of its own still pushes every targeted weight down.
