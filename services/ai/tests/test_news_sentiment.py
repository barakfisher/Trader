"""Lexicon sentiment: the clear cases, and the limits it admits to.

Only unambiguous copy is asserted here. A test that pinned this lexicon's opinion
of a subtle sentence would be asserting a bug: the module's docstring says it
cannot read structure, and a test should describe behaviour the code promises.
"""

from app.news.sentiment import (
    LEXICON_MODEL_NAME,
    MAGNITUDE_SATURATION_HITS,
    LexiconSentimentScorer,
)


async def score(title: str, body: str):
    return await LexiconSentimentScorer().score(title, body)


class TestClearCases:
    async def test_clearly_positive_copy_scores_positive(self):
        result = await score(
            "Apple posts record services revenue",
            "Apple beat its own guidance, growth remained strong and it raised its outlook.",
        )
        assert result.score > 0
        assert result.model == LEXICON_MODEL_NAME

    async def test_clearly_negative_copy_scores_negative(self):
        result = await score(
            "Nvidia slumps after wider export rules",
            "The company warned on revenue, one broker downgraded the shares and the "
            "stock tumbled, with concerns about the shortfall.",
        )
        assert result.score < 0

    async def test_copy_with_no_loaded_vocabulary_is_neutral_and_says_so(self):
        result = await score(
            "Ten-year yields ease after an inflation print lands in line",
            "Components were little changed from the prior month and the curve was flat.",
        )
        assert result.is_neutral
        # The two numbers exist to keep this case distinguishable from a balanced
        # one: no signal, not a cancelled-out signal.
        assert result.score == 0.0
        assert result.magnitude == 0.0

    async def test_balanced_copy_is_neutral_with_magnitude(self):
        result = await score(
            "Mixed session",
            "One holding surged on a record order while another plunged on a warning.",
        )
        assert result.score == 0.0
        assert result.magnitude > 0.0


class TestMechanics:
    async def test_negation_flips_the_term_it_governs(self):
        plain = await score("Results", "The company beat expectations.")
        negated = await score("Results", "The company did not beat expectations.")
        assert plain.score > 0
        assert negated.score < 0

    async def test_magnitude_saturates_rather_than_growing_without_bound(self):
        loaded = "record growth strong surged rallied upgraded robust momentum wins gains"
        result = await score("Records", loaded * 3)
        assert result.magnitude == 1.0

    async def test_magnitude_is_proportional_below_saturation(self):
        result = await score("Note", "Revenue growth continued.")
        assert result.magnitude == round(1 / MAGNITUDE_SATURATION_HITS, 4)

    async def test_score_is_a_balance_not_a_count(self):
        # A longer article is not more positive for being longer.
        short = await score("Note", "Growth was strong.")
        long = await score(
            "Note", "Growth was strong. " + "The quarter was unremarkable otherwise. " * 20
        )
        assert short.score == long.score

    async def test_the_scorer_names_itself_so_a_score_can_be_attributed(self):
        result = await score("Note", "Growth was strong.")
        assert result.model == LexiconSentimentScorer.name == LEXICON_MODEL_NAME
