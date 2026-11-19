"""Which filings provider this installation reads, from `filings_provider` (D404)."""

from __future__ import annotations

from app.config import Settings
from app.filings.base import FilingsProvider
from app.filings.edgar import EdgarFilingsProvider
from app.filings.fixture import FixtureFilingsProvider


def build_filings_provider(settings: Settings) -> FilingsProvider | None:
    """The configured provider; None when the setting is `off`."""
    if settings.filings_provider == "edgar":
        return EdgarFilingsProvider(user_agent=settings.edgar_user_agent)
    if settings.filings_provider == "fixture":
        return FixtureFilingsProvider(settings.fixtures_dir)
    return None
