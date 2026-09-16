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

The day bucket is deliberately coarse. A price that crosses the threshold at
10:00 and is still across it at 15:00 is one event, not five. Two genuinely
distinct events on the same instrument, on the same day, at the same severity,
from the same rule, will collapse into one - accepted knowingly: under-reporting
a repeat is a smaller harm than a feed that repeats itself, and the second event
is visible in the evidence of the first day's observation.
"""

from __future__ import annotations

import hashlib

from app.analysis.findings import Finding


def dedupe_key(finding: Finding) -> str:
    """A stable identity for `finding`, safe to use as a unique constraint."""
    bucket = finding.as_of.date().isoformat()
    material = "|".join([finding.kind, finding.subject_ref, finding.severity, bucket])
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]
    # The prefix keeps the column readable in psql when something goes wrong.
    return f"{finding.kind}:{digest}"
