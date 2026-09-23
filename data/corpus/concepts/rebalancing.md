---
slug: rebalancing
title: Rebalancing
source: traders-curated
license: CC0-1.0
---

## What it is

Rebalancing is the act of moving a portfolio's actual weights back toward its
target weights - trimming what has grown past its target and adding to what has
fallen below it.

It is worth being precise about what the word means *here*, because this system
uses it for a specific and deliberately limited thing.

**This system never places an order.** When your allocation drifts past a
threshold, it raises a **proposal**: a question, with a deadline, that you can
approve, reject or snooze. Approving a proposal records that you assented to it
and does nothing else. There is no broker connection in this product, and an
approved rebalance does not buy, sell, or move a single share.

## How it is computed

A drift finding becomes a proposal when two conditions hold: the observation's
kind is one that implies an action a person could assent to, and its severity
clears the floor you set. Allocation drift is currently the only kind that
qualifies. "NVDA fell 7.2% today" is an observation about the world with nothing
to approve; "your allocation has drifted 12 points from your target" implies
something you might choose to do.

A proposal carries a deadline - twenty-four hours by default - and it is
recomputed on every read rather than trusted from the stored row, so a proposal
whose deadline has passed can never be answered even if a sweep has not yet got
around to marking it.

What an approval writes is one row in a ledger of **intents**: the proposal it
answers, the kind of action, and when you assented. Exactly one row per
proposal, enforced by the database, because tapping Approve twice is one act and
usually means the first reply was lost. A second tap returns "unchanged", which
is a success rather than an error - you did nothing wrong.

Rejecting and snoozing are recorded too. Nothing on this path is silently
dropped.

## How to read it

Treat an approved proposal as a note to yourself that you decided something, not
as an instruction that was carried out. If you want the portfolio to actually
change, you place the trades yourself, wherever you actually hold the assets,
and then update your holdings here so the weights reflect reality.

The drift threshold is a setting, not a recommendation. It defaults to about
five percentage points, which is roughly where the cost of a transaction starts
to be worth considering against the size of the gap - but that trade-off depends
on your costs, your taxes and your account, none of which this system knows.

This product reports and explains. It does not advise, and nothing in a proposal
is a judgement that acting would be better than not acting.

## Common misreadings

**Believing approval executes something.** It does not. The ledger row is a
record of assent, deliberately shaped so that it is not an order anybody could
submit, and every confirmation this system sends says so in as many words. If
your broker statement is meant to change, you are the one who has to change it.

**Reading a proposal as a recommendation to act.** A proposal says a threshold
you set was crossed. Whether crossing it warrants a transaction is a judgement
involving costs this system cannot see, and letting an allocation drift is a
legitimate answer - which is why Reject and Snooze exist and are recorded
exactly as carefully as Approve.

**Assuming rebalancing improves returns.** It is a discipline for keeping a
portfolio's risk close to the shape you chose. Trimming winners to buy laggards
frequently *reduces* return over a long rising stretch; what it does reliably is
stop the portfolio from quietly becoming something you did not choose.

**Forgetting that an expired proposal is not a decision.** A deadline that
passes without an answer leaves the drift exactly where it was. The question
stops being answerable; the condition that raised it does not go away, and the
next scan will see it again.
