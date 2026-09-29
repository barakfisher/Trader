"""The outlet -> home country table (decision 61).

What is pinned: outlets are looked up however GDELT spells them, an unlisted
outlet has no country rather than a guessed one, a malformed line is skipped,
and the committed table loads and knows the outlets the measurement relied on.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.config import Settings
from app.news.outlet_countries import load_outlet_countries, parse_table

LINES = [
    "abc.net.au\tAS\tAustralia\n",
    "cnn.com\tUS\tUnited States\n",
    "broken-line-without-a-country\n",
    "\tUS\tUnited States\n",
]


def test_an_outlet_is_found_however_spelled() -> None:
    table = parse_table(LINES)
    for source in ("abc.net.au", "WWW.ABC.NET.AU", " abc.net.au "):
        country = table.country(source)
        assert country is not None
        assert (country.code, country.name) == ("AS", "Australia")


def test_an_unlisted_outlet_has_no_country() -> None:
    assert parse_table(LINES).country("new-outlet.example") is None


def test_malformed_lines_are_skipped_not_guessed() -> None:
    assert len(parse_table(LINES)) == 2


def test_a_code_names_its_country() -> None:
    table = parse_table(LINES)
    assert table.name("AS") == "Australia"
    assert table.name("ZZ") is None


def test_the_committed_table_knows_the_outlets_the_rule_was_measured_on() -> None:
    table = load_outlet_countries(Settings(_env_file=None).outlets_dir)  # type: ignore[call-arg]
    assert len(table) > 180_000
    expected = {"moneycontrol.com": "IN", "abc.net.au": "AS", "cnn.com": "US"}
    assert {s: getattr(table.country(s), "code", None) for s in expected} == expected


def test_a_missing_table_is_an_error_not_an_empty_one(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_outlet_countries(str(tmp_path))
