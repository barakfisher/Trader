"""Refuse any figure the evidence does not support.

This is where guideline 7 stops being a principle and becomes a mechanism. A
language model asked to explain a price move will, given the chance, supply
numbers that were never in its input: a plausible previous close, a market cap,
a percentage that reads well. In a product whose entire output is claims about
someone's money, a fabricated figure with a confident sentence around it is the
worst thing we can ship - worse than saying nothing, because it is indetectable
by the reader.

So every number in generated text is checked against the finding's evidence, and
a narration containing even one unsupported figure is discarded whole. The
caller falls back to a deterministic template. The failure mode is deliberately
blunt: partial trust in a sentence is not a thing we can offer.

Matching has to tolerate how a number is *written* without tolerating a
different number:

  * minor units in evidence, major units in prose - `price_minor: 11845` is
    written "$118.45", and ONLY that: "$11845" is the same digits a hundred
    times too large, and a model reading raw evidence writes exactly that;
  * ratios in evidence, percentages in prose - `change_pct: -0.085` is written
    "-8.5%" or "8.5%";
  * rounding - a value is accepted if it rounds to the written figure at the
    precision the writer chose, so "8.5%" matches -0.08502 but "8.6%" does not;
  * an unsigned mention - "fell 8.5%" drops the minus that "-8.5%" carries;
  * numbers quoted from evidence strings, such as a headline containing "20-year"
    or a date containing 2026;
  * a window the evidence names in a key: tools label their windows as keys
    (`"60d": null`, `"5d": "5.29"`), which hold no number to match, and two of
    four real scans were refused for "a 60-day range" (2026-10-07). So a whole
    number written straight before a unit of time - "60-day", "over 5 days",
    "60 יום" - is sourced when a key names that window (`60d`). A window no key
    names is still a figure: "its worst day in 14 months" is a claim about
    history nobody supplied. The figure a window qualifies - "up 5.29% over 5
    days" - is checked as ever.

Everything else is unsourced, including a figure that is merely plausible.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from decimal import Decimal, InvalidOperation

from app.core.logging import get_logger
from app.core.money import minor_unit_exponent

log = get_logger("narration.validator")

#: Numbers as they appear in prose: optional sign, thousands separators, decimals.
#: A leading currency symbol or a trailing % is stripped by the caller, because
#: the unit is irrelevant to whether the VALUE is supported.
_NUMBER_PATTERN = re.compile(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?")

#: Keys whose values are integer minor units, so prose will divide them by 10 to
#: the power of the currency's exponent: 100 for USD, 1 for JPY.
_MINOR_SUFFIX = "_minor"

#: Markers identifying a key whose value is a ratio, so prose will multiply it by
#: 100. Matched anywhere in the key rather than as a suffix: the drift rule names
#: its central figure `drift`, not `drift_pct`, and a suffix rule left a correct
#: template failing its own check.
_RATIO_MARKERS = ("pct", "ratio", "weight", "drift")

#: An ISO 8601 date, optionally followed by a time. Timestamps are mined for
#: their DATE only: the clock components of "2026-09-16T11:30:00+00:00" are 11,
#: 30 and 0, and admitting those would quietly whitelist most small integers -
#: enough for "fallen 30% this year" to read as sourced. A narration may quote
#: the day something happened; it has no business quoting the minute.
#: A percent sign after a number, allowing one space ("3 %").
_PERCENT_AFTER = re.compile(r" ?%")

_ISO_DATE_PREFIX = re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)")

#: A unit of time straight after a number, joined by a hyphen, a maqaf or one
#: space - "60-day", "52 weeks", "20 ימי" - captured as its key letter (d, w, m,
#: y). English and Hebrew, the languages a thesis is written in (D51).
_WINDOW_UNITS = {
    "d": r"(?:trading[- ])?days?|sessions?|יום|ימים|ימי",
    "w": r"weeks?|שבוע|שבועות",
    "m": r"months?|חודש|חודשים",
    "y": r"years?|שנה|שנים",
}
_WINDOW_AFTER = {
    unit: re.compile(rf"(?:-|\u05be| )(?:{words})(?![a-z])")
    for unit, words in _WINDOW_UNITS.items()
}
#: A key naming a window: "5d", "60d", "52w", "change_20d".
_WINDOW_KEY = re.compile(r"(?:^|_)(\d{1,3})([dwmy])$")


def _to_decimal(value: object) -> Decimal | None:
    if isinstance(value, bool):  # bool is an int; a flag is not a figure
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int | float):
        return Decimal(str(value))
    return None


def _forms_for(
    key: str, value: Decimal, currency: str | None, percent: bool = False
) -> set[Decimal]:
    """Every value a writer could legitimately render this evidence entry as.

    A minor-unit figure's major form depends on its currency: 15000 JPY is
    written "15,000", and accepting "150.00" as well would let the validator
    approve a figure understated a hundredfold. With no currency declared the
    exponent is 2, the common case.

    The raw minor figure is *not* a form. Accepting it approved "fell to 4016
    from a high of 4750" for a $40.16 price - a hundredfold overstatement that
    read as sourced because the digits were in the evidence. For a currency
    with no minor unit (JPY) the two forms coincide, so nothing is lost there.
    """
    is_ratio = any(marker in key for marker in _RATIO_MARKERS)
    if key.endswith(_MINOR_SUFFIX):
        forms = {value.scaleb(-minor_unit_exponent(currency or ""))}
    elif is_ratio and percent:
        # A ratio written with "%" is its hundredfold: 0.03 is "3%". Its bare
        # digits with a percent sign ("0.03%") state a figure a hundred times
        # too small, and were accepted because the digits were in the evidence.
        forms = set()
    else:
        forms = {value}
    if is_ratio:
        forms.add(value * 100)
    # A writer may drop the sign: "fell 8.5%" rather than "changed by -8.5%".
    return {form for base in list(forms) for form in (base, -base)}


def sourced_values(
    evidence: Mapping[str, object],
    _key: str = "",
    _currency: str | None = None,
    *,
    percent: bool = False,
) -> set[Decimal]:
    """Collect every figure the evidence supports, in each renderable form.

    Walks nested structures, because evidence carries lists of contributing
    positions and nested threshold blocks. Strings are mined for the numbers
    inside them so that a quoted headline or an ISO date does not read as
    invention.

    A mapping's `currency` applies to the minor-unit figures inside it, nested
    ones included, until a nested mapping declares its own.

    A mapping nested directly under a key passes that key's meaning down: the
    values of `thresholds_pct: {"high": 0.25}` are ratios, so "the 25% high
    threshold" is sourced. Measured 2026-10-07: 34 of 38 rejected narrations
    quoted a threshold, true and refused, because `high` names no ratio. A
    mapping inside a list starts afresh - a list of positions is not itself a
    ratio, whatever it is called.

    `percent` asks for the values a figure followed by "%" may take: a ratio's
    hundredfold, never its bare digits.
    """
    found: set[Decimal] = set()

    if isinstance(evidence, Mapping):
        declared = evidence.get("currency")
        if isinstance(declared, str) and declared:
            _currency = declared
        for key, value in evidence.items():
            child = f"{_key}.{key}" if _key else str(key)
            found |= sourced_values(value, child, _currency, percent=percent)  # type: ignore[arg-type]
        return found

    if isinstance(evidence, str):
        # A string that is entirely one number is a number: this project
        # transports exact decimals as strings precisely so they do not round
        # through a float, so a portfolio weight arrives as "0.7000" and prose
        # will write it as 70%. Reading it as prose would strip the key's
        # meaning and leave a correct template failing its own check.
        whole = _parse(evidence.strip())
        if whole is not None:
            return _forms_for(_key, whole, _currency, percent)

        iso = _ISO_DATE_PREFIX.match(evidence)
        tokens = iso.groups() if iso else _NUMBER_PATTERN.findall(evidence)
        for token in tokens:
            number = _parse(token)
            if number is not None:
                found |= {number, -number}
        return found

    if isinstance(evidence, Iterable) and not isinstance(evidence, str | bytes):
        for item in evidence:
            # A mapping in a list names its own fields: "positions" is not a ratio.
            key = "" if isinstance(item, Mapping) else _key
            found |= sourced_values(item, key, _currency, percent=percent)  # type: ignore[arg-type]
        return found

    number = _to_decimal(evidence)
    if number is not None:
        found |= _forms_for(_key, number, _currency, percent)
    return found


def _parse(token: str) -> Decimal | None:
    try:
        return Decimal(token.replace(",", ""))
    except InvalidOperation:
        return None


def _supported(written: Decimal, places: int, sourced: set[Decimal]) -> bool:
    """Does any sourced value round to `written` at the precision it was written?

    Implemented as a half-unit tolerance at the written precision rather than by
    quantizing, because quantize applies banker's rounding: "8%" would then be
    accepted for 8.5 while "9%" was refused, which is an arbitrary distinction to
    impose on a writer. A half unit accepts either, and still refuses $118.40 for
    $118.45 - the tolerance there is half a cent.

    Rounding to a coarser figure is a legitimate way to describe a number.
    Changing it is not.
    """
    tolerance = Decimal(5).scaleb(-places - 1)  # half of the last written digit
    return any(abs(candidate - written) <= tolerance for candidate in sourced)


def named_windows(evidence: object) -> set[tuple[int, str]]:
    """The windows the evidence's keys name, as (length, unit): `{"60d": ...}` is (60, "d")."""
    found: set[tuple[int, str]] = set()
    if isinstance(evidence, Mapping):
        for key, value in evidence.items():
            match = _WINDOW_KEY.search(str(key))
            if match:
                found.add((int(match.group(1)), match.group(2)))
            found |= named_windows(value)
    elif isinstance(evidence, Iterable) and not isinstance(evidence, str | bytes):
        for item in evidence:
            found |= named_windows(item)
    return found


def _is_named_window(token: str, text: str, end: int, windows: set[tuple[int, str]]) -> bool:
    """A window's length - "60-day" - that a key in the evidence names."""
    if not token.isdigit():
        return False
    return any(
        (int(token), unit) in windows and pattern.match(text, end) is not None
        for unit, pattern in _WINDOW_AFTER.items()
    )


def unsourced_figures(text: str, evidence: Mapping[str, object]) -> list[str]:
    """Figures in `text` that the evidence does not support, in order of appearance."""
    sourced = sourced_values(evidence)
    as_percent = sourced_values(evidence, percent=True)
    windows = named_windows(evidence)
    offenders: list[str] = []

    for match in _NUMBER_PATTERN.finditer(text):
        token = match.group()
        written = _parse(token)
        if written is None:
            continue
        places = -written.as_tuple().exponent if written.as_tuple().exponent < 0 else 0
        if _is_named_window(token, text, match.end(), windows):
            continue
        is_percent = _PERCENT_AFTER.match(text, match.end()) is not None
        if not _supported(written, places, as_percent if is_percent else sourced):
            offenders.append(token)

    return offenders


def is_supported(text: str, evidence: Mapping[str, object]) -> bool:
    """True when every figure in `text` traces back to the evidence."""
    offenders = unsourced_figures(text, evidence)
    if offenders:
        log.warning("narration.unsourced_figures", figures=offenders, text=text[:200])
    return not offenders
