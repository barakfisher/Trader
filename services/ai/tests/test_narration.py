"""Narration: the model gets one chance, and loses it on any unsourced figure."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from app.analysis.findings import Finding
from app.llm.base import (
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

    async def complete(self, *, system, user, max_output_tokens=None, temperature=None):
        self.calls += 1
        if self._error:
            raise self._error
        return LLMCompletion(
            provider=self.name,
            text=self._reply or "",
            model=self.model,
            usage=TokenUsage(prompt_tokens=100, completion_tokens=50),
            estimated_cost_micro_usd=0,
        )


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
