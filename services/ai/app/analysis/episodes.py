"""States are said when they cross a band, not every day they persist (decision 132).

Drawdown and allocation drift describe where a subject *is*, not what happened
to it today. The dedupe key buckets by day (`dedupe.py`), which is right for an
event and wrong for a state: a holding that sits 25% below its high for ten days
would be ten observations saying the same thing.

So a state finding belongs to an **episode**, which the orchestrator keeps in
`finding_episodes` (0049) because it owns the write. The scan is told which
episodes are open and the highest band each has written; a state finding at or
below that band is already said, and is counted like any other known finding
rather than narrated. A higher band is news, and is written.

The episode ends when the subject drops below the `info` band - the rule finds
nothing - and that decision is the orchestrator's too, made from `stats.seen`.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from app.analysis.findings import SEVERITY_ORDER, Finding, FindingKind, Severity

#: The finding kinds that are states. Migration 0049's `STATE_KINDS` is tested
#: against this, because its CHECK refuses an episode of any other kind.
STATE_KINDS: frozenset[FindingKind] = frozenset({"drawdown", "allocation_drift"})


@dataclass(frozen=True, slots=True)
class OpenEpisode:
    """An open episode as the caller holds it: the highest band it has written."""

    kind: str
    subject_ref: str
    severity: Severity


class EpisodeBook:
    """The open episodes, looked up by the finding they would cover."""

    def __init__(self, episodes: Iterable[OpenEpisode] = ()) -> None:
        self._written: dict[tuple[str, str], int] = {}
        for episode in episodes:
            key = (episode.kind, episode.subject_ref)
            rank = SEVERITY_ORDER.index(episode.severity)
            # Two rows for one subject cannot exist (a partial unique index), but
            # if they did, the higher band is the one already said.
            self._written[key] = max(rank, self._written.get(key, -1))

    def already_said(self, finding: Finding) -> bool:
        """Whether `finding` is a state its open episode has already reached."""
        if finding.kind not in STATE_KINDS:
            return False
        written = self._written.get((finding.kind, finding.subject_ref))
        return written is not None and SEVERITY_ORDER.index(finding.severity) <= written
