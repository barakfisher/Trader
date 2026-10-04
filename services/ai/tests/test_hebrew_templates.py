"""The Hebrew narration: every rule has one, and it says nothing the English could not.

The findings come from the rules themselves rather than from evidence written
by hand, for the reason `TestTemplatesAgainstRealFindings` in
`test_narration.py` gives: a template is a contract with the rule that produced
its evidence, and hand-written evidence tests only one end of it.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import get_args

import pytest

from app.analysis import (
    AnalysisThresholds,
    PositionValue,
    allocation_drift_findings,
    drawdown_findings,
    price_move_findings,
    sigma_move_findings,
)
from app.analysis.findings import Finding, FindingKind
from app.analysis.price_series import PricePoint
from app.analysis.topic_move import TopicMember, topic_move_findings
from app.narration import TRANSLATED_LANGUAGES, localize, narrate
from app.narration.evidence_validator import unsourced_figures
from app.narration.hebrew_templates import explanation_for, headline_for

NOW = datetime(2026, 9, 16, 14, 0, tzinfo=UTC)
ISOLATED = re.compile("[\u2066\u2068][^\u2066\u2068\u2069]*\u2069")


def series(closes: list[int], currency: str = "USD") -> list[PricePoint]:
    start = NOW - timedelta(days=len(closes))
    return [
        PricePoint(as_of=start + timedelta(days=index), price_minor=close, currency=currency)
        for index, close in enumerate(closes)
    ]


def findings_of_every_kind() -> list[Finding]:
    thresholds = AnalysisThresholds()
    moving = series([10000 + (index % 3) * 20 for index in range(40)] + [9100])
    falling = series([15000] + [14000 - index * 100 for index in range(20)])
    quiet = [10000, 10050] * 15 + [10000]
    findings = [
        *price_move_findings("TEST", moving, thresholds),
        *sigma_move_findings("TEST", moving, thresholds),
        *drawdown_findings("TEST", falling, thresholds),
        *allocation_drift_findings(
            [
                PositionValue(symbol="AAA", value_minor=700_000, currency="USD", as_of=NOW),
                PositionValue(symbol="BBB", value_minor=300_000, currency="USD", as_of=NOW),
            ],
            {"AAA": Decimal("0.4"), "BBB": Decimal("0.6")},
            thresholds,
            base_currency="USD",
        ),
        *topic_move_findings(
            "5f0c1d2e-0000-4000-8000-000000000001",
            "uranium",
            [
                TopicMember(symbol="CCJ", points=series([*quiet, 9400])),
                TopicMember(symbol="NXE", points=series([*quiet, 9500])),
                TopicMember(symbol="UEC", points=series([*quiet, 9600])),
            ],
            thresholds,
        ).findings,
    ]
    return findings


FINDINGS = findings_of_every_kind()


def test_the_fixtures_cover_every_rule():
    # A rule added without a Hebrew template would otherwise pass every test
    # below by never being asked.
    assert {finding.kind for finding in FINDINGS} == set(get_args(FindingKind))


@pytest.mark.parametrize("finding", FINDINGS, ids=lambda finding: finding.kind)
def test_every_figure_is_in_the_evidence(finding: Finding):
    for text in (headline_for(finding), explanation_for(finding)):
        assert unsourced_figures(text, finding.evidence) == [], text


@pytest.mark.parametrize("finding", FINDINGS, ids=lambda finding: finding.kind)
def test_nothing_left_to_right_is_left_outside_an_isolate(finding: Finding):
    # A figure outside an isolate is reordered in a right-to-left line ("-26.5%"
    # reads "26.5%-"); a Latin word outside one is an untranslated fragment.
    for text in (headline_for(finding), explanation_for(finding)):
        remainder = ISOLATED.sub("", text)
        assert not re.search(r"[0-9A-Za-z%+]", remainder), remainder


@pytest.mark.parametrize("finding", FINDINGS, ids=lambda finding: finding.kind)
def test_every_rule_has_its_own_hebrew_headline(finding: Finding):
    # The fallback for an unknown kind is "<symbol>: <kind>", which would pass
    # the checks above while saying nothing.
    assert finding.kind.replace("_", " ") not in headline_for(finding)


def test_a_topic_is_named_by_its_label_not_its_id():
    (finding,) = [finding for finding in FINDINGS if finding.kind == "topic_move"]
    # A label is the user's own text, in either script: first-strong, not forced LTR.
    assert "\u2068uranium\u2069" in headline_for(finding)
    assert finding.subject_ref.split(":")[-1] not in headline_for(finding)


def test_every_translated_language_is_localised_and_serialisable():
    localized = localize(FINDINGS[0])
    assert tuple(localized) == TRANSLATED_LANGUAGES
    # Stored as jsonb by the orchestrator: the isolates must survive the trip.
    assert json.loads(json.dumps(localized)) == localized


async def test_a_template_narration_carries_its_translations():
    narration = await narrate(FINDINGS[0], [], None)
    assert narration.localized == localize(FINDINGS[0])
