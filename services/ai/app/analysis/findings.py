"""What a rule produces, and how a number becomes a severity.

Every rule in this package returns `Finding` objects and nothing else. A finding
is a *machine* statement: a kind, a severity, the subject it is about, the
observation time it describes, and the numbers it rests on. It carries no
sentence, because the wording arrives later from the narration step - and that
step is only allowed to state figures that appear in `evidence` (DESIGN.md
section 5, step 6). So `evidence` is not a debugging aid: anything a future
sentence might mention has to be in it, or the sentence cannot be written.

Severity is derived, never chosen. A rule declares three ascending magnitude
bands and `severity_for` maps a computed statistic onto them:

    |statistic| <  info                  -> no finding at all
    info    <= |statistic| <  notable    -> "info"
    notable <= |statistic| <  high       -> "notable"
    high    <= |statistic|               -> "high"

The same ladder is used by every rule, so "notable" means the same shape of
thing everywhere: the statistic cleared the band the operator configured for it.
The magnitude is always an absolute value - a 6% fall and a 6% rise are equally
worth reporting, and the sign lives in the evidence.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

Severity = Literal["info", "notable", "high"]

FindingKind = Literal["price_move", "sigma_move", "drawdown", "allocation_drift", "topic_move"]

#: Ascending, so callers can compare or sort severities without a lookup table.
SEVERITY_ORDER: tuple[Severity, ...] = ("info", "notable", "high")


@dataclass(frozen=True, slots=True)
class SeverityBands:
    """Three ascending magnitudes: the emit floor, then notable, then high.

    `info` doubles as the rule's threshold. Keeping the three in one object is
    what stops thresholds from becoming twelve unrelated constants sprinkled
    across four modules, and validating the order here means a mis-ordered
    configuration fails at construction instead of silently rating everything
    "high".
    """

    info: float
    notable: float
    high: float

    def __post_init__(self) -> None:
        if not 0 < self.info <= self.notable <= self.high:
            raise ValueError(
                "severity bands must be positive and ascending, got "
                f"info={self.info}, notable={self.notable}, high={self.high}"
            )

    def as_evidence(self) -> dict[str, float]:
        """The bands, for the evidence mapping.

        A sentence may well want to say "beyond the 3% threshold", so the
        threshold it would quote has to be sourced like every other figure.
        """
        return {"info": self.info, "notable": self.notable, "high": self.high}


def severity_for(magnitude: float, bands: SeverityBands) -> Severity | None:
    """Map a statistic's magnitude onto a severity, or None when below the floor.

    Returning None rather than raising is deliberate: "nothing happened here" is
    the overwhelmingly common answer, and the rules read as filters because of
    it.
    """
    size = abs(magnitude)
    if size >= bands.high:
        return "high"
    if size >= bands.notable:
        return "notable"
    if size >= bands.info:
        return "info"
    return None


def cap_severity(severity: Severity, ceiling: Severity) -> Severity:
    """Lower `severity` to `ceiling` when it exceeds it.

    Used where the numbers clear a band but the data behind them does not deserve
    the operator's attention at that level - see the stdev floor in
    `sigma_move.py`. Capping is preferable to dropping the finding: the move did
    happen, and hiding it would be inventing calm.
    """
    return severity if SEVERITY_ORDER.index(severity) <= SEVERITY_ORDER.index(ceiling) else ceiling


@dataclass(frozen=True, slots=True)
class Finding:
    """One deterministic observation candidate.

    `as_of` is the observation time of the data the finding describes, taken from
    the series and never from a clock. Two runs over the same rows therefore
    produce identical findings, which is what lets step 8 of the pipeline
    deduplicate them.

    `subject_ref` follows the `observations.subject_ref` convention:
    `instrument:AAPL`, `portfolio:allocation:AAPL`.
    """

    kind: FindingKind
    severity: Severity
    subject_ref: str
    as_of: datetime
    evidence: dict[str, object] = field(default_factory=dict)
