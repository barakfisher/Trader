"""One scan: rules, then context, then words.

The order is the point. Deterministic rules run first and produce findings with
their evidence; news is attached as context; narration comes last and is
discarded if it says anything the evidence does not support. A failure at any
later stage degrades the output rather than losing the finding - the arithmetic
already happened, and the finding is the part that matters.

The pipeline reports what it skipped as loudly as what it found. A scan that
silently produces nothing is indistinguishable from a quiet market, which is the
failure mode this project keeps having to design against.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.analysis.allocation_drift import PositionValue, allocation_drift_findings
from app.analysis.dedupe import dedupe_key
from app.analysis.drawdown import drawdown_findings
from app.analysis.findings import Finding
from app.analysis.price_move import price_move_findings
from app.analysis.price_series import PricePoint
from app.analysis.quote_history import load_price_series
from app.analysis.sigma_move import sigma_move_findings
from app.analysis.thresholds import AnalysisThresholds
from app.analysis.topic_move import TopicMember, topic_move_findings
from app.core.logging import get_logger
from app.llm.base import LLMProvider
from app.narration import CandidateArticle, correlate, narrate
from app.narration.narrator import Narration

log = get_logger("analysis.pipeline")

#: How much history to load. The longest window any rule uses, plus slack for
#: weekends, holidays and a symbol that went unpriced for a while.
HISTORY_DAYS = 120


@dataclass(frozen=True, slots=True)
class ScanSubject:
    """One holding as the scan sees it.

    `value_minor` is None when the orchestrator could not price the holding. It
    is carried rather than dropped so the scan can say that drift was skipped
    and why, instead of quietly omitting it.
    """

    instrument_id: str
    symbol: str
    value_minor: int | None
    currency: str
    #: When the price behind `value_minor` was observed. Required for allocation
    #: drift, which dates a weight by the stalest price contributing to it - a
    #: weight is only as current as its oldest input.
    as_of: datetime | None = None


@dataclass
class ScanStats:
    """What the scan did, recorded on the run.

    Skips are first-class: `drift_skipped_reason` exists because allocation
    drift falling silent on a partially priced portfolio is correct behaviour
    that must still be visible.
    """

    subjects: int = 0
    subjects_with_history: int = 0
    findings: int = 0
    narrated_by_llm: int = 0
    narration_fallbacks: dict[str, int] = field(default_factory=dict)
    drift_skipped_reason: str | None = None
    insufficient_history: list[str] = field(default_factory=list)
    #: Findings the caller already has. Counted rather than narrated: see the
    #: note above `run_portfolio_scan`.
    already_known: int = 0


@dataclass(frozen=True, slots=True)
class ScanObservation:
    """A finding with its words and its identity, ready to persist."""

    finding: Finding
    narration: Narration
    dedupe_key: str


async def run_portfolio_scan(
    connection: object,
    subjects: Sequence[ScanSubject],
    target_weights: Mapping[str, Decimal | str | int],
    *,
    base_currency: str,
    thresholds: AnalysisThresholds,
    llm: LLMProvider | None,
    articles: Sequence[CandidateArticle] = (),
    known_dedupe_keys: Iterable[str] = (),
    now: datetime | None = None,
) -> tuple[list[ScanObservation], ScanStats]:
    """Run every rule over `subjects`, narrate what is new, and report the rest.

    Identity is decided before narration, not after. The rules are deterministic
    and the scan runs every half hour, so most of what a scan finds is what the
    last scan found - and narrating a finding the caller already has means paying
    a model to write a sentence that is then discarded on insert. At a
    thirty-minute cadence with eight findings, that is some two hundred
    throwaway narrations a day.

    `known_dedupe_keys` is what the caller has already stored. Findings matching
    one are counted in `already_known` and dropped here, so the cost of a repeat
    is a hash rather than a completion.
    """
    moment = now or datetime.now(UTC)
    since = moment - timedelta(days=HISTORY_DAYS)
    stats = ScanStats(subjects=len(subjects))
    findings: list[Finding] = []

    for subject in subjects:
        points = load_price_series(connection, subject.instrument_id, since=since)
        if len(points) < 2:
            # Not an error: a holding added today has no history to analyse yet.
            stats.insufficient_history.append(subject.symbol)
            continue
        stats.subjects_with_history += 1
        findings.extend(price_move_findings(subject.symbol, points, thresholds))
        findings.extend(sigma_move_findings(subject.symbol, points, thresholds))
        findings.extend(drawdown_findings(subject.symbol, points, thresholds))

    unpriced = [subject.symbol for subject in subjects if subject.value_minor is None]
    if not target_weights:
        # No targets means nothing to drift from. Recorded rather than passed
        # over, because "no drift found" and "drift was never checked" look
        # identical in an empty feed.
        stats.drift_skipped_reason = "no target weights configured"
    elif unpriced:
        # A partial denominator overstates every weight, so drift is skipped
        # rather than computed wrongly - and the skip is recorded, because a
        # silent absence reads exactly like "nothing has drifted".
        stats.drift_skipped_reason = (
            f"{len(unpriced)} of {len(subjects)} holdings could not be priced "
            f"({', '.join(sorted(unpriced)[:5])})"
        )
    elif target_weights:
        findings.extend(
            allocation_drift_findings(
                [
                    PositionValue(
                        symbol=subject.symbol,
                        value_minor=subject.value_minor,
                        currency=base_currency,
                        as_of=subject.as_of,
                    )
                    for subject in subjects
                ],
                target_weights,
                thresholds,
                base_currency=base_currency,
            )
        )

    stats.findings = len(findings)

    observations = await _narrate_new(findings, known_dedupe_keys, llm, stats, articles)

    log.info(
        "analysis.scan_complete",
        subjects=stats.subjects,
        findings=stats.findings,
        already_known=stats.already_known,
        narrated_by_llm=stats.narrated_by_llm,
        drift_skipped=bool(stats.drift_skipped_reason),
    )
    return observations, stats


@dataclass(frozen=True, slots=True)
class TopicInstrument:
    instrument_id: str
    symbol: str


@dataclass(frozen=True, slots=True)
class TopicSubject:
    """One active topic and its confirmed instruments, as the orchestrator holds them."""

    topic_id: str
    label: str
    instruments: Sequence[TopicInstrument]


@dataclass
class TopicScanStats:
    """What a topic scan did. `skipped` maps a topic label to why it was not measured."""

    topics: int = 0
    topics_measured: int = 0
    instruments: int = 0
    findings: int = 0
    already_known: int = 0
    narrated_by_llm: int = 0
    narration_fallbacks: dict[str, int] = field(default_factory=dict)
    skipped: dict[str, str] = field(default_factory=dict)


async def run_topic_scan(
    connection: object,
    topics: Sequence[TopicSubject],
    *,
    thresholds: AnalysisThresholds,
    llm: LLMProvider | None,
    known_dedupe_keys: Iterable[str] = (),
    now: datetime | None = None,
) -> tuple[list[ScanObservation], TopicScanStats]:
    """Measure each topic's basket, narrate what is new, and report every skip.

    Topics overlap - a uranium topic and a nuclear topic share half their names -
    so each instrument's history is loaded once for the whole scan rather than once
    per topic. Identity, narration and the already-known short cut are the same as
    `run_portfolio_scan`'s, for the same reasons.
    """
    moment = now or datetime.now(UTC)
    since = moment - timedelta(days=HISTORY_DAYS)
    stats = TopicScanStats(topics=len(topics))

    series: dict[str, list[PricePoint]] = {}
    for topic in topics:
        for instrument in topic.instruments:
            if instrument.instrument_id not in series:
                series[instrument.instrument_id] = load_price_series(
                    connection, instrument.instrument_id, since=since
                )
    stats.instruments = len(series)

    findings: list[Finding] = []
    for topic in topics:
        result = topic_move_findings(
            topic.topic_id,
            topic.label,
            [
                TopicMember(symbol=item.symbol, points=series[item.instrument_id])
                for item in topic.instruments
            ],
            thresholds,
        )
        if result.skipped_reason is not None:
            # Keyed by label rather than id: this lands in `runs.stats`, which is
            # read by a person asking why their topic said nothing.
            stats.skipped[topic.label] = result.skipped_reason
            continue
        stats.topics_measured += 1
        findings.extend(result.findings)

    stats.findings = len(findings)
    observations = await _narrate_new(findings, known_dedupe_keys, llm, stats)

    log.info(
        "analysis.topic_scan_complete",
        topics=stats.topics,
        measured=stats.topics_measured,
        findings=stats.findings,
        already_known=stats.already_known,
        skipped=len(stats.skipped),
    )
    return observations, stats


async def _narrate_new(
    findings: Sequence[Finding],
    known_dedupe_keys: Iterable[str],
    llm: LLMProvider | None,
    stats: ScanStats | TopicScanStats,
    articles: Sequence[CandidateArticle] = (),
) -> list[ScanObservation]:
    """Drop what the caller already holds, and put words to the rest."""
    known = set(known_dedupe_keys)
    observations: list[ScanObservation] = []
    for finding in findings:
        key = dedupe_key(finding)
        if key in known:
            # Same rule, same subject, same severity, same day: the feed already
            # says this. Nothing new to write and nothing to pay for.
            stats.already_known += 1
            continue
        narration = await narrate(finding, list(correlate(finding, list(articles))), llm)
        if narration.source == "llm":
            stats.narrated_by_llm += 1
        else:
            reason = narration.fallback_reason
            stats.narration_fallbacks[reason] = stats.narration_fallbacks.get(reason, 0) + 1
        observations.append(ScanObservation(finding=finding, narration=narration, dedupe_key=key))
    return observations
