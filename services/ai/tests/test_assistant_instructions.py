"""The assistant's prompt: the rules the code cannot enforce on its own."""

from __future__ import annotations

from datetime import UTC, datetime

from app.assistant.instructions import instructions


def test_the_reply_is_in_the_language_of_the_question() -> None:
    """D220: the one exception to "`/ask` answers stay English", on every surface."""
    prompt = instructions(now=datetime(2026, 10, 20, tzinfo=UTC), timezone="UTC", step_limit=8)

    assert "Write in English." not in prompt
    assert "language of the user's latest message" in prompt
    assert "Hebrew" in prompt
