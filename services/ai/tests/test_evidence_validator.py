"""The mechanism behind guideline 7: no figure without evidence."""

from __future__ import annotations

import pytest

from app.narration.evidence_validator import is_supported, sourced_values, unsourced_figures

EVIDENCE = {
    "symbol": "NVDA",
    "currency": "USD",
    "price_minor": 11845,
    "previous_price_minor": 12945,
    "change_pct": -0.085,
    "z_score": -3.8167,
    "sample_size": 60,
    "articles": [
        {
            "title": "Nvidia slumps after a 20-year supply deal lapses",
            "published_at": "2026-09-16T11:30:00+00:00",
        }
    ],
}


@pytest.mark.parametrize(
    "text",
    [
        "NVDA fell 8.5% to $118.45.",
        "NVDA fell from $129.45 to $118.45.",
        "A 3.8 standard deviation move.",
        "Measured over 60 daily moves.",
        "Reported alongside a 20-year supply deal lapsing.",  # figure from a headline
        "Published on 2026-09-16.",  # figure from a date in evidence
        "NVDA fell about 9%.",  # a coarser rounding of 8.5 is still 8.5
        "NVDA fell 8%.",  # and so is the other direction
    ],
)
def test_supported_figures_are_accepted(text):
    assert unsourced_figures(text, EVIDENCE) == []


@pytest.mark.parametrize(
    ("text", "offender"),
    [
        ("NVDA fell 8.5% on 12% lower volume.", "12"),  # volume is not in evidence
        ("NVDA dropped to $118.40.", "118.40"),  # close, and wrong
        ("A 4.2 standard deviation move.", "4.2"),
        ("NVDA has fallen 30% this year.", "30"),
        ("Its market capitalisation is $2.9 trillion.", "2.9"),
    ],
)
def test_invented_figures_are_rejected(text, offender):
    assert offender in unsourced_figures(text, EVIDENCE)


def test_a_single_bad_figure_condemns_the_whole_narration():
    # Partial trust in a sentence is not something this product can offer.
    text = "NVDA fell 8.5% to $118.45, its worst day in 14 months."
    assert not is_supported(text, EVIDENCE)


def test_minor_units_are_matched_in_major_form():
    assert unsourced_figures("The price is $118.45", {"price_minor": 11845}) == []


def test_minor_units_written_raw_are_a_hundredfold_overstatement():
    # Seen live (2026-09-29): a model wrote "fell to 4016 from a high of 4750"
    # for URA at $40.16, and the validator approved it because the digits were
    # in the evidence. They were cents.
    evidence = {"currency": "USD", "price_minor": 4016, "high_price_minor": 4750}
    assert unsourced_figures("fell to 4016 from a high of 4750", evidence) == ["4016", "4750"]
    assert unsourced_figures("fell to $40.16 from a high of $47.50", evidence) == []
    assert unsourced_figures("The price is $11845", {"price_minor": 11845}) == ["11845"]


def test_minor_units_follow_the_currency_exponent():
    # A yen has no cents. Accepting "150.00" for 15000 JPY would approve a figure
    # understated a hundredfold, which is the one thing this check exists to stop.
    evidence = {"currency": "JPY", "price_minor": 15000}
    assert unsourced_figures("It trades at ¥15,000.", evidence) == []
    assert unsourced_figures("It trades at 150.00 JPY.", evidence) == ["150.00"]


def test_a_nested_currency_overrides_the_outer_one():
    evidence = {
        "currency": "USD",
        "positions": [{"currency": "JPY", "value_minor": 15000}, {"value_minor": 11845}],
    }
    assert unsourced_figures("15,000 yen and $118.45", evidence) == []
    assert unsourced_figures("150.00 yen", evidence) == ["150.00"]


def test_ratios_are_matched_as_percentages():
    assert unsourced_figures("down 8.5%", {"change_pct": -0.085}) == []
    assert unsourced_figures("down 0.085", {"change_pct": -0.085}) == []


def test_precision_is_the_writers_choice_not_a_licence_to_change_the_value():
    evidence = {"change_pct": 0.08502}
    assert unsourced_figures("rose 8.5%", evidence) == []
    assert unsourced_figures("rose 8.50%", evidence) == []
    assert unsourced_figures("rose 8.6%", evidence) == ["8.6"]


def test_booleans_are_flags_not_figures():
    # True is an int in Python; treating it as the figure 1 would let a model
    # write "1" and have it silently accepted.
    assert unsourced_figures("it moved 1%", {"floor_applied": True}) == ["1"]


def test_text_without_figures_is_always_supported():
    assert is_supported("NVDA fell sharply after the announcement.", {})


def test_sourced_values_walks_nested_evidence():
    values = sourced_values({"outer": {"inner": [{"deep": 42}]}})
    assert any(value == 42 for value in values)


# -- measured 2026-10-07 over 38 rejected narrations ------------------------------


DRAWDOWN = {
    "symbol": "SMR",
    "currency": "USD",
    "price_minor": 790,
    "high_price_minor": 1118,
    "drawdown_pct": -0.29338103756708406,
    "thresholds_pct": {"info": 0.1, "notable": 0.15, "high": 0.25},
}


def test_a_threshold_is_a_percentage_like_the_block_it_sits_in():
    # 34 of 38 rejections quoted a true threshold: `high` names no ratio, the block does.
    text = "SMR is 29.3% below its high, past the 25% high threshold."
    assert unsourced_figures(text, DRAWDOWN) == []
    weights = {"thresholds_weight": {"info": 0.05}}
    assert unsourced_figures("beyond the 5% information band", weights) == []


def test_a_mapping_in_a_list_does_not_inherit_the_lists_name():
    # "weights" is a list of positions, not a ratio: their dollar values stay dollars.
    evidence = {"currency": "USD", "weights": [{"value_minor": 832550}]}
    assert unsourced_figures("worth $8,325.50", evidence) == []
    assert unsourced_figures("worth 832550", evidence) == ["832550"]


def test_a_ratios_bare_digits_with_a_percent_sign_are_a_hundredfold_too_small():
    # Passed before: "the 0.03% information threshold" for a threshold of 3%.
    evidence = {"change_pct": -0.036, "thresholds_pct": {"info": 0.03}}
    assert unsourced_figures("past the 0.03% threshold", evidence) == ["0.03"]
    assert unsourced_figures("past the 0.03 % threshold", evidence) == ["0.03"]
    assert unsourced_figures("past the 3% threshold", evidence) == []


def test_a_genuinely_small_percentage_is_still_accepted():
    assert unsourced_figures("moved 0.03%", {"change_pct": 0.0003}) == []


def test_a_copied_minor_unit_price_is_still_refused():
    # 30 of 38 rejections wrote "fell to 790" for $7.90; that stays wrong.
    assert unsourced_figures("fell to 790 from 1118", DRAWDOWN) == ["790", "1118"]
    assert unsourced_figures("fell to $7.90 from $11.18", DRAWDOWN) == []
