"""How a scan's answer is read out of what the model wrote (D397).

The shapes below are the four answers production refused between 2026-11-03 and
2026-11-09, shortened: each held a complete, valid answer, and the text around it
cost the whole scan. Prose around the object is not evidence and is never shown,
so dropping it changes nothing the figure check reads: that check reads the thesis
inside the object, as before.
"""

from __future__ import annotations

import pytest

from app.agents.answer import NOT_AN_OBJECT, SEVERAL_OBJECTS, parse_answer

PASS = '{"trades": [], "thesis": "No trade: nothing fits the mandate today."}'
THESIS = "No trade: nothing fits the mandate today."


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param(PASS, id="bare"),
        pytest.param(f"```json\n{PASS}\n```", id="fenced"),
        # Opus, 2026-11-03 and 2026-11-04: a paragraph, then the object.
        pytest.param(f"I'm not proposing any trades in this scan.\n\n{PASS}", id="prose-before"),
        # Opus, 2026-11-04 21:29: a paragraph, then a fenced object.
        pytest.param(
            f"I'm making no trades this scan.\n\n```json\n{PASS}\n```", id="prose-then-fence"
        ),
        # Flash Lite, 2026-11-09: one closing brace too many.
        pytest.param(PASS + "}", id="extra-brace"),
        pytest.param(f"Some text {{with braces}} first.\n{PASS}", id="braces-in-prose"),
    ],
)
def test_the_answer_object_is_read_whatever_surrounds_it(raw: str) -> None:
    parsed, problems = parse_answer(raw)

    assert problems == []
    assert parsed is not None
    assert parsed.thesis == THESIS
    assert parsed.trades == ()


def test_a_trade_after_prose_is_read_too() -> None:
    raw = (
        "Here is my decision.\n"
        '{"trades": [{"symbol": "AXON", "decision": "buy", "quantity": "6", '
        '"thesis": "A small contrarian position."}]}'
    )

    parsed, problems = parse_answer(raw)

    assert problems == []
    assert parsed is not None
    assert [trade.symbol for trade in parsed.trades] == ["AXON"]


@pytest.mark.parametrize(
    "raw",
    ["no answer at all", "", "[1, 2]", '"just a string"', '{"trades": [], "thesis": "cut off'],
)
def test_text_with_no_answer_object_is_still_refused(raw: str) -> None:
    assert parse_answer(raw) == (None, [NOT_AN_OBJECT])


def test_two_answer_objects_are_refused_rather_than_one_chosen() -> None:
    raw = f'{PASS}\n{{"trades": [], "thesis": "A second, different answer."}}'

    assert parse_answer(raw) == (None, [SEVERAL_OBJECTS])
