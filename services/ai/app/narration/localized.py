"""An observation's words in the languages other than English.

English is the observation's own `headline` and `explanation`, whoever wrote
them. Every other language is the deterministic template, rendered here at the
moment the observation is written and stored beside it (`observations.localized`,
migration 0035), so a reader in that language is served without a model call,
a second code path in the orchestrator, or a render on every page load.

A model-written observation is still localised from the template: its English
prose is not translated (decision 98 in `.claude/MEMORY.md`). The model narrates
in English only, and a Hebrew reader gets the template's plainer sentence with
the same checked figures rather than a translation nobody validated.

Adding a language is a module like `hebrew_templates.py`, an entry here, and a
widening of `user_settings.language` - the parity test refuses the first two
apart.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Literal, TypedDict

from app.analysis.findings import Finding
from app.narration import hebrew_templates

#: The languages an observation is stored in besides English.
TranslatedLanguage = Literal["he"]


class LocalizedText(TypedDict):
    headline: str
    explanation: str


_RENDERERS: dict[TranslatedLanguage, tuple[Callable[[Finding], str], Callable[[Finding], str]]] = {
    "he": (hebrew_templates.headline_for, hebrew_templates.explanation_for),
}

TRANSLATED_LANGUAGES: tuple[TranslatedLanguage, ...] = tuple(_RENDERERS)


def localize(finding: Finding) -> dict[TranslatedLanguage, LocalizedText]:
    """The finding's template narration in every translated language."""
    return {
        language: LocalizedText(headline=headline(finding), explanation=explanation(finding))
        for language, (headline, explanation) in _RENDERERS.items()
    }
