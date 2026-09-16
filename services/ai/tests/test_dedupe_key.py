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


class TestStatesDoNotRepeatDaily:
    """A drawdown is not something that happened; it is something that is true.

    With a day bucket, "SMR is -26.5% from its 30-day high" re-announced itself
    every morning for as long as the decline lasted. In a feed that is clutter;
    in Milestone 4, where the same key gates Telegram, it is a notification every
    morning about something already known.
    """

    def state(self, day: int, **overrides) -> Finding:
        return finding(
            kind=overrides.pop("kind", "drawdown"),
            as_of=datetime(2026, 9, day, 14, 0, tzinfo=UTC),
            **overrides,
        )

    def test_a_continuing_drawdown_is_one_observation_all_week(self):
        # 14th to 18th September 2026 is Monday to Friday of one ISO week.
        keys = {dedupe_key(self.state(day)) for day in (14, 15, 16, 17, 18)}
        assert len(keys) == 1

    def test_it_does_surface_again_the_following_week(self):
        # Short enough that a continuing condition is still surfaced.
        assert dedupe_key(self.state(16)) != dedupe_key(self.state(23))

    def test_a_deepening_drawdown_is_reported_at_once(self):
        # Severity is in the key regardless of bucket, so notable -> high is a
        # new thing to say and is said the day it happens.
        assert dedupe_key(self.state(16, severity="notable")) != dedupe_key(
            self.state(16, severity="high")
        )

    def test_allocation_drift_behaves_the_same_way(self):
        drift = {"kind": "allocation_drift", "subject_ref": "portfolio:allocation:VOO"}
        assert dedupe_key(self.state(14, **drift)) == dedupe_key(self.state(18, **drift))

    def test_events_still_bucket_by_day(self):
        # A price move on Tuesday and another on Wednesday are two events, and
        # both deserve saying. Only states persist.
        assert dedupe_key(self.state(15, kind="price_move")) != dedupe_key(
            self.state(16, kind="price_move")
        )

    def test_an_unknown_kind_buckets_by_day(self):
        # The cautious direction: repeat rather than go quiet.
        assert dedupe_key(self.state(15, kind="future_rule")) != dedupe_key(
            self.state(16, kind="future_rule")
        )
