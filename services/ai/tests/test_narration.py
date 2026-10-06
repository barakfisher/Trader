"""Narration: the model gets one chance, and loses it on any unsourced figure."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from app.analysis.findings import Finding
from app.llm.base import (
    Caller,
    LLMBudgetExceededError,
    LLMCompletion,
    LLMRequestError,
    LLMUnavailableError,
    TokenUsage,
)
from app.narration import CandidateArticle, correlate, narrate
from app.narration.evidence_validator import is_supported
from app.narration.templates import explanation_for, headline_for

NOW = datetime(2026, 9, 16, 14, 0, tzinfo=UTC)

PRICE_MOVE = Finding(
    kind="price_move",
    severity="high",
    subject_ref="instrument:NVDA",
    as_of=NOW,
    evidence={
        "symbol": "NVDA",
        "currency": "USD",
        "price_minor": 11845,
        "previous_price_minor": 12945,
        "change_pct": -0.085,
    },
)


class StubLLM:
    """A provider that says exactly what a test tells it to."""

    name = "stub"
    model = "stub-model"
    charges_per_token = False

    def __init__(self, reply: str | None = None, error: Exception | None = None) -> None:
        self._reply = reply
        self._error = error
        self.calls = 0
        self.call_id = 7
        self.verdicts: list[tuple[int | None, str]] = []

    async def complete(
        self,
        *,
        system,
        user,
        max_output_tokens=None,
        temperature=None,
        reasoning_effort=None,
        caller=None,
    ):
        self.calls += 1
        if self._error:
            raise self._error
        return LLMCompletion(
            provider=self.name,
            text=self._reply or "",
            model=self.model,
            usage=TokenUsage(prompt_tokens=100, completion_tokens=50),
            estimated_cost_micro_usd=0,
            call_id=self.call_id,
        )

    async def record_verdict(self, call_id, verdict):
        self.verdicts.append((call_id, verdict))


def reply(headline: str, explanation: str) -> str:
    return json.dumps({"headline": headline, "explanation": explanation})


async def test_a_well_sourced_narration_is_used():
    llm = StubLLM(reply("NVDA fell 8.5% to $118.45", "It went from $129.45 to $118.45."))
    result = await narrate(PRICE_MOVE, [], llm)
    assert result.source == "llm"
    assert result.fallback_reason == "none"
    assert "8.5%" in result.headline


async def test_an_invented_figure_costs_the_whole_narration():
    # The headline here is perfectly sourced. The explanation is not, and that is
    # enough: partial trust in a sentence is not something this product offers.
    llm = StubLLM(
        reply("NVDA fell 8.5% to $118.45", "Its worst day in 14 months, on 12% lower volume.")
    )
    result = await narrate(PRICE_MOVE, [], llm)
    assert result.source == "template"
    assert result.fallback_reason == "unsourced_figures"
    assert result.headline == headline_for(PRICE_MOVE)


async def test_a_looping_reply_is_malformed_even_as_valid_json():
    # Parses, and its one figure is sourced - and it is still not a sentence.
    llm = StubLLM(reply("NVDA fell 8.5%", "Itsellsellsellsellsellsellsellsellsellsell fell 8.5%."))
    result = await narrate(PRICE_MOVE, [], llm)
    assert result.source == "template"
    assert result.fallback_reason == "malformed"


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (LLMUnavailableError("no model configured"), "no_provider"),
        (LLMBudgetExceededError(500_000, 500_000, "2026-09-16"), "budget_exhausted"),
        (LLMRequestError("stub", "upstream exploded", status_code=500), "provider_error"),
    ],
)
async def test_every_llm_failure_ends_at_the_template(error, expected):
    result = await narrate(PRICE_MOVE, [], StubLLM(error=error))
    assert result.source == "template"
    assert result.fallback_reason == expected
    assert result.headline  # an observation always has a headline


async def test_no_provider_at_all_is_not_an_error():
    result = await narrate(PRICE_MOVE, [], None)
    assert result.source == "template"
    assert result.fallback_reason == "no_provider"


@pytest.mark.parametrize(
    "text",
    ["not json at all", '{"headline": "only one field"}', '{"headline": "", "explanation": ""}'],
)
async def test_a_malformed_reply_falls_back(text):
    result = await narrate(PRICE_MOVE, [], StubLLM(text))
    assert result.source == "template"
    assert result.fallback_reason == "malformed"


async def test_a_fenced_reply_is_tolerated():
    # Models add code fences regardless of instructions.
    fenced = "```json\n" + reply("NVDA fell 8.5%", "From $129.45 to $118.45.") + "\n```"
    result = await narrate(PRICE_MOVE, [], StubLLM(fenced))
    assert result.source == "llm"


async def test_templates_satisfy_their_own_validator():
    # If the deterministic floor could not pass the check, the check would be
    # unsatisfiable and the product would always fall back to nothing.
    for finding in (PRICE_MOVE,):
        text = f"{headline_for(finding)} {explanation_for(finding)}"
        assert is_supported(text, finding.evidence)


def test_a_yen_price_is_not_divided_into_cents():
    finding = Finding(
        kind="price_move",
        severity="high",
        subject_ref="instrument:7203.T",
        as_of=NOW,
        evidence={
            "symbol": "7203.T",
            "currency": "JPY",
            "price_minor": 2850,
            "previous_price_minor": 3000,
            "change_pct": -0.05,
        },
    )
    assert headline_for(finding) == "7203.T moved -5.0% to 2850 JPY"
    assert explanation_for(finding).startswith("7203.T went from 3000 JPY to 2850 JPY")
    assert is_supported(f"{headline_for(finding)} {explanation_for(finding)}", finding.evidence)


async def test_article_headlines_join_the_evidence():
    # A figure inside a quoted headline must not read as invention.
    article = CandidateArticle(
        article_id="a1",
        symbol="NVDA",
        title="Nvidia slumps after a 20-year supply deal lapses",
        url="https://example.com/a1",
        source="Example Wire",
        published_at=NOW - timedelta(hours=2),
        salience=0.9,
    )
    llm = StubLLM(
        reply(
            "NVDA fell 8.5%",
            "The move coincided with a report of a 20-year supply deal lapsing.",
        )
    )
    result = await narrate(PRICE_MOVE, [article], llm)
    assert result.source == "llm"
    assert result.evidence["articles"][0]["title"] == article.title


class TestCorrelation:
    def article(self, symbol: str, hours: float, salience: float = 0.5) -> CandidateArticle:
        return CandidateArticle(
            article_id=f"{symbol}-{hours}",
            symbol=symbol,
            title=f"{symbol} news",
            url="https://example.com",
            source="Example Wire",
            published_at=NOW - timedelta(hours=hours),
            salience=salience,
        )

    def test_recent_articles_about_the_subject_are_offered(self):
        assert correlate(PRICE_MOVE, [self.article("NVDA", 2)]) != []

    def test_another_instruments_news_is_not(self):
        # A wrong link becomes a wrong explanation, which is worse than none.
        assert correlate(PRICE_MOVE, [self.article("AAPL", 2)]) == []

    def test_stale_news_explains_nothing(self):
        assert correlate(PRICE_MOVE, [self.article("NVDA", 24 * 10)]) == []

    def test_a_story_filed_shortly_after_the_move_still_counts(self):
        # Publication timestamps lag the events they report.
        assert correlate(PRICE_MOVE, [self.article("NVDA", -6)]) != []

    def test_a_story_from_tomorrow_does_not(self):
        assert correlate(PRICE_MOVE, [self.article("NVDA", -48)]) == []

    def test_most_salient_first_and_capped(self):
        articles = [self.article("NVDA", h, salience=h / 10) for h in range(1, 8)]
        result = correlate(PRICE_MOVE, articles, limit=3)
        assert len(result) == 3
        assert [a.salience for a in result] == sorted((a.salience for a in result), reverse=True)


class TestTemplatesAgainstRealRuleOutput:
    """Templates built from evidence the rules actually emit, not invented dicts.

    The first version of these templates read `peak_price_minor` while the
    drawdown rule writes `high_price_minor`. Every unit test passed, because
    every unit test supplied evidence I had written myself; the scan failed the
    moment it ran against a real finding. A template is a contract with the rule
    that produced the evidence, so the test has to hold both ends.
    """

    def series(self, closes: list[int], currency: str = "USD") -> list:
        from datetime import timedelta

        from app.analysis.price_series import PricePoint

        start = NOW - timedelta(days=len(closes))
        return [
            PricePoint(as_of=start + timedelta(days=index), price_minor=close, currency=currency)
            for index, close in enumerate(closes)
        ]

    async def narrate_all(self, findings):
        results = []
        for finding in findings:
            result = await narrate(finding, [], None)
            assert result.source == "template"
            text = f"{result.headline} {result.explanation}"
            assert is_supported(text, finding.evidence), text
            results.append(text)
        return results

    # JPY because its minor unit is the yen itself: a template or validator that
    # assumed cents would pass every USD case and be wrong a hundredfold here.
    @pytest.mark.parametrize("currency", ["USD", "JPY"])
    async def test_price_and_sigma_templates_match_the_rules(self, currency):
        from app.analysis import AnalysisThresholds, price_move_findings, sigma_move_findings

        thresholds = AnalysisThresholds()
        closes = [10000 + (index % 3) * 20 for index in range(40)] + [9100]
        points = self.series(closes, currency)
        findings = price_move_findings("TEST", points, thresholds) + sigma_move_findings(
            "TEST", points, thresholds
        )
        assert findings, "the fixture series must actually trigger these rules"
        await self.narrate_all(findings)

    @pytest.mark.parametrize("currency", ["USD", "JPY"])
    async def test_drawdown_template_matches_the_rule(self, currency):
        from app.analysis import AnalysisThresholds, drawdown_findings

        closes = [15000] + [14000 - index * 100 for index in range(20)]
        findings = drawdown_findings("TEST", self.series(closes, currency), AnalysisThresholds())
        assert findings, "the fixture series must actually trigger a drawdown"
        for text in await self.narrate_all(findings):
            # "below" carries the direction; a signed figure made it "-15.5% below".
            assert "-" not in text.split(" below ")[0].rsplit(",", 1)[-1], text

    async def test_allocation_drift_template_matches_the_rule(self):
        from decimal import Decimal

        from app.analysis import AnalysisThresholds, PositionValue, allocation_drift_findings

        findings = allocation_drift_findings(
            [
                PositionValue(symbol="AAA", value_minor=700_000, currency="USD", as_of=NOW),
                PositionValue(symbol="BBB", value_minor=300_000, currency="USD", as_of=NOW),
            ],
            {"AAA": Decimal("0.4"), "BBB": Decimal("0.6")},
            AnalysisThresholds(),
            base_currency="USD",
        )
        assert findings, "the fixture weights must actually drift"
        await self.narrate_all(findings)


class TestVerdicts:
    """Narration names itself and its user, and says what it made of each reply."""

    async def test_an_accepted_narration_is_recorded_as_accepted(self) -> None:
        finding = PRICE_MOVE
        llm = StubLLM(reply("NVDA fell 8.5% to $118.45", "It went from $129.45 to $118.45."))
        captured: dict[str, object] = {}
        original = llm.complete

        async def spying(**kwargs):  # type: ignore[no-untyped-def]
            captured.update(kwargs)
            return await original(**kwargs)

        llm.complete = spying  # type: ignore[method-assign]
        await narrate(finding, [], llm, user_id="u-1")
        assert captured["caller"] == Caller(purpose="narration", user_id="u-1")
        assert llm.verdicts == [(7, "accepted")]

    async def test_a_reply_it_could_not_use_is_recorded_with_why(self) -> None:
        malformed = StubLLM("not json")
        await narrate(PRICE_MOVE, [], malformed)
        assert malformed.verdicts == [(7, "malformed")]

        invented = StubLLM(reply("NVDA fell 8.5%", "Its worst day in 14 months."))
        await narrate(PRICE_MOVE, [], invented)
        assert invented.verdicts == [(7, "unsourced_figures")]
