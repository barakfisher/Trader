from datetime import UTC, datetime, timedelta

from app.analysis.dedupe import dedupe_key
from app.analysis.findings import Finding


def finding(**overrides) -> Finding:
    defaults = {
        "kind": "price_move",
        "severity": "high",
        "subject_ref": "instrument:NVDA",
        "as_of": datetime(2026, 9, 16, 14, 0, tzinfo=UTC),
        "evidence": {"change_pct": -0.085},
    }
    return Finding(**{**defaults, **overrides})


def test_the_same_finding_keys_the_same():
    assert dedupe_key(finding()) == dedupe_key(finding())


def test_evidence_does_not_affect_identity():
    # A re-scan minutes later sees a slightly different price. It is still the
    # same event, and must not be reported twice.
    assert dedupe_key(finding()) == dedupe_key(finding(evidence={"change_pct": -0.0861}))


def test_a_later_scan_on_the_same_day_keys_the_same():
    later = finding(as_of=datetime(2026, 9, 16, 19, 30, tzinfo=UTC))
    assert dedupe_key(finding()) == dedupe_key(later)


def test_a_different_day_is_a_different_observation():
    tomorrow = finding(as_of=finding().as_of + timedelta(days=1))
    assert dedupe_key(finding()) != dedupe_key(tomorrow)


def test_severity_changes_identity():
    # A move that deepens is a new thing to say, not a repeat.
    assert dedupe_key(finding()) != dedupe_key(finding(severity="notable"))


def test_rule_and_subject_change_identity():
    assert dedupe_key(finding()) != dedupe_key(finding(kind="sigma_move"))
    assert dedupe_key(finding()) != dedupe_key(finding(subject_ref="instrument:AAPL"))


def test_key_is_readable_and_bounded():
    key = dedupe_key(finding())
    assert key.startswith("price_move:")
    assert len(key) <= 64
