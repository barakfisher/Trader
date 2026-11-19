"""Offline filings provider backed by `data/fixtures/filings.json`.

What CI and the offline demo run on: no network, no SEC. The file holds search
rows and submissions documents in EDGAR's own shapes, parsed by the same code
as the real provider (`edgar.parse_submissions`), so a fixture that drifts from what
SEC answers fails the same way the real one would.

Dates are fixed, as in the news fixture: a window that does not include them
finds nothing, which is the honest answer.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import date
from pathlib import Path
from typing import Any

from app.filings.base import CompanyFilings, FilingHit, FilingsProviderError
from app.filings.edgar import cik10, parse_submissions

FIXTURE_FILENAME = "filings.json"


def root_form(form: str) -> str:
    """`S-1/A` -> `S-1`: what EDGAR's search matches a form filter against."""
    return form.split("/", 1)[0]


class FixtureFilingsProvider:
    name = "fixture"

    def __init__(self, fixtures_dir: str | Path | None = None, *, data: Any = None) -> None:
        if data is None:
            path = Path(str(fixtures_dir)) / FIXTURE_FILENAME
            data = json.loads(path.read_text(encoding="utf-8"))
        self._hits: list[dict[str, str]] = list(data.get("hits", []))
        self._companies: dict[str, Any] = {
            cik10(cik): body for cik, body in data.get("companies", {}).items()
        }

    async def search(self, forms: Sequence[str], start: date, end: date) -> list[FilingHit]:
        roots = {root_form(form) for form in forms}
        hits = [
            FilingHit(
                cik=cik10(row["cik"]),
                accession=row["accession"],
                form=row["form"],
                filed_on=date.fromisoformat(row["filed_on"]),
            )
            for row in self._hits
        ]
        return [
            hit for hit in hits if root_form(hit.form) in roots and start <= hit.filed_on <= end
        ]

    async def company(self, cik: str) -> CompanyFilings:
        body = self._companies.get(cik10(cik))
        if body is None:
            raise FilingsProviderError(self.name, f"{cik}: not in the fixture")
        return parse_submissions(body)
