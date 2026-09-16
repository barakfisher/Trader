"""The key that stops a re-scan from saying the same thing twice.

A scan runs every half hour. The rules are deterministic, so a scan over
unchanged data produces the same findings as the one before it - which is the
point, and also the problem: without a key, a 30-minute cadence would write the
same observation 13 times a day and, from Milestone 4, send 13 notifications.

The key is a hash of what makes a finding *the same finding*:

  * the rule that produced it, and what it is about;
  * the severity, so a move that deepens from notable to high is a new thing to
    say rather than a repeat;
  * the day the observed data belongs to, taken from the finding's own `as_of`
    rather than from a clock, so re-running yesterday's scan today does not
    manufacture a new observation.

The bucket is deliberately coarse, and how coarse depends on what the rule
describes.

**Events bucket by day.** A price crossing its threshold at 10:00 and still
across it at 15:00 is one event, not five. A genuinely distinct second event on
the same instrument, the same day, at the same severity collapses into the first
- accepted knowingly: under-reporting a repeat is a smaller harm than a feed
that repeats itself, and the second move is visible in the first observation's
evidence.

**States bucket by week.** A drawdown and an allocation drift are not things
that happened; they are things that are *true*, and they stay true for weeks. A
day bucket made them re-announce every morning: "SMR is -26.5% from its 30-day
high", again, about a decline the reader was told about yesterday and the day
before. In a feed that is clutter. In Milestone 4, where the same key gates
Telegram, it is a notification every morning about something already known,
which is how a person comes to mute a bot - and a muted bot delivers nothing,
including the alert that mattered.

A week is short enough that a continuing condition is still surfaced, and long
enough that it is not nagging. Severity is part of the key regardless, so a
drawdown deepening from notable to high is a new thing to say and is said
immediately, whatever week it falls in. A condition that ends and recurs a month
later is also new, because the week has changed.
"""

from __future__ import annotations

import hashlib

from app.analysis.findings import Finding, FindingKind

#: Rules describing something that *happened*, dated to the day it happened.
EVENT_KINDS: frozenset[FindingKind] = frozenset({"price_move", "sigma_move"})

#: Rules describing something that *is true*, and stays true. Bucketed by week
#: so a continuing condition is surfaced without being repeated daily.
STATE_KINDS: frozenset[FindingKind] = frozenset({"drawdown", "allocation_drift"})


def time_bucket(finding: Finding) -> str:
    """The span within which this finding counts as the same finding.

    An unknown kind buckets by day, which is the cautious direction: it repeats
    more often rather than going quiet, and a feed that says too much is easier
    to notice than one that says too little.
    """
    if finding.kind in STATE_KINDS:
        year, week, _ = finding.as_of.isocalendar()
        return f"{year}-W{week:02d}"
    return finding.as_of.date().isoformat()


def dedupe_key(finding: Finding) -> str:
    """A stable identity for `finding`, safe to use as a unique constraint."""
    bucket = time_bucket(finding)
    material = "|".join([finding.kind, finding.subject_ref, finding.severity, bucket])
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]
    # The prefix keeps the column readable in psql when something goes wrong.
    return f"{finding.kind}:{digest}"
