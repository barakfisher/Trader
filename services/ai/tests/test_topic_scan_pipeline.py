"""The topic scan: overlapping topics, skips by label, and repeats that cost a hash."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.analysis.dedupe import dedupe_key
from app.analysis.pipeline import TopicInstrument, TopicSubject, run_topic_scan
from app.analysis.price_series import PricePoint
from app.analysis.thresholds import AnalysisThresholds

NOW = datetime(2026, 9, 16, 14, 0, tzinfo=UTC)
QUIET = [10000, 10050] * 10 + [10000]


def _points(closes: list[int]) -> list[PricePoint]:
    start = NOW - timedelta(days=len(closes))
    return [
        PricePoint(as_of=start + timedelta(days=index), price_minor=close, currency="USD")
        for index, close in enumerate(closes)
    ]


class StubConnection:
    """Serves each instrument's history by id, and counts the loads."""

    def __init__(self, histories: dict[str, list[PricePoint]]) -> None:
        self._histories = histories
        self.loads: list[str] = []

    def execute(self, _statement, parameters):
        instrument_id = parameters["instrument_id"]
        self.loads.append(instrument_id)
        return [
            type(
                "Row", (), {"as_of": p.as_of, "price_minor": p.price_minor, "currency": p.currency}
            )
            for p in self._histories.get(instrument_id, [])
        ]


FALLING = _points([*QUIET, 9_300])
HISTORIES = {"ccj": FALLING, "nxe": FALLING, "bwxt": FALLING, "lonely": FALLING}

URANIUM = TopicSubject(
    topic_id="t-uranium",
    label="uranium",
    instruments=[TopicInstrument("ccj", "CCJ"), TopicInstrument("nxe", "NXE")],
)
NUCLEAR = TopicSubject(
    topic_id="t-nuclear",
    label="nuclear power",
    instruments=[TopicInstrument("ccj", "CCJ"), TopicInstrument("bwxt", "BWXT")],
)
SOLO = TopicSubject(
    topic_id="t-solo", label="one name", instruments=[TopicInstrument("lonely", "LONE")]
)


async def test_each_topic_is_measured_and_shared_instruments_are_loaded_once():
    connection = StubConnection(HISTORIES)

    observations, stats = await run_topic_scan(
        connection, [URANIUM, NUCLEAR], thresholds=AnalysisThresholds(), llm=None, now=NOW
    )

    assert sorted(item.finding.subject_ref for item in observations) == [
        "topic:t-nuclear",
        "topic:t-uranium",
    ]
    assert sorted(connection.loads) == ["bwxt", "ccj", "nxe"]
    assert (stats.topics, stats.topics_measured, stats.instruments) == (2, 2, 3)
    assert all(item.narration.source == "template" for item in observations)


async def test_a_topic_that_cannot_be_measured_is_reported_by_label():
    _, stats = await run_topic_scan(
        StubConnection(HISTORIES),
        [URANIUM, SOLO],
        thresholds=AnalysisThresholds(),
        llm=None,
        now=NOW,
    )

    assert stats.topics_measured == 1
    assert set(stats.skipped) == {"one name"}


async def test_a_finding_the_caller_already_holds_is_counted_not_narrated():
    first, _ = await run_topic_scan(
        StubConnection(HISTORIES), [URANIUM], thresholds=AnalysisThresholds(), llm=None, now=NOW
    )
    known = [dedupe_key(item.finding) for item in first]

    again, stats = await run_topic_scan(
        StubConnection(HISTORIES),
        [URANIUM],
        thresholds=AnalysisThresholds(),
        llm=None,
        known_dedupe_keys=known,
        now=NOW,
    )

    assert again == []
    assert stats.already_known == 1
