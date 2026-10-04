"""The deterministic narration, in Hebrew.

Same rules as `templates.py`, which is the authority on what each sentence may
say: arithmetic on the evidence and nothing else, every figure rendered by the
same helpers so the evidence validator accepts the Hebrew exactly as it accepts
the English. Only the phrasing differs, and it follows the web catalogue's
vocabulary (`he.json`: "ירידה מהשיא", "משקל יעד", "סטיות תקן") so a term reads
the same in a sentence as in the label beside it.

Every figure and every symbol is wrapped in a left-to-right isolate, and a
topic label - the user's own text, in either script - in a first-strong one. Inside a
right-to-left sentence, `-26.5%` without one is laid out by the Unicode bidi
algorithm as `26.5%-`, and `SMR` followed by a Hebrew word can swap places
with its neighbour. An isolate is understood by every surface this text
reaches - the web page, Telegram, a mail client - where markup is not, and it
is invisible: the validator's number pattern skips it like any other non-digit.

Subjects are phrased to avoid grammatical gender. Hebrew agrees verbs with
their subject, and a ticker has no gender a sentence could agree with, so the
sentence is about "the price of" or "the weight of" the instrument instead.
"""

from __future__ import annotations

from decimal import Decimal

from app.analysis.findings import Finding
from app.narration.templates import money, sigma_of, signed_pct, symbol_of

#: LEFT-TO-RIGHT ISOLATE ... POP DIRECTIONAL ISOLATE.
_LRI = "\u2066"
_PDI = "\u2069"


#: FIRST-STRONG ISOLATE: text whose direction is its own.
_FSI = "\u2068"


def _ltr(text: object) -> str:
    """A figure or a symbol, kept left to right inside a Hebrew sentence."""
    return f"{_LRI}{text}{_PDI}"


def _own(text: str) -> str:
    """Text the user wrote, such as a topic label: it may be in either script,
    so its direction is taken from its first strong character."""
    return f"{_FSI}{text}{_PDI}"


def headline_for(finding: Finding) -> str:
    evidence = finding.evidence
    symbol = _ltr(symbol_of(finding))
    currency = str(evidence.get("currency", ""))

    if finding.kind == "price_move":
        price = _ltr(money(evidence["price_minor"], currency))
        return f"מחיר {symbol} השתנה ב־{_ltr(signed_pct(evidence['change_pct']))} ל־{price}"

    if finding.kind == "sigma_move":
        sigma = abs(Decimal(str(evidence["z_score"])).quantize(Decimal("0.1")))
        return (
            f"מחיר {symbol} השתנה ב־{_ltr(signed_pct(evidence['change_pct']))}, "
            f"{_ltr(sigma)} סטיות תקן מהממוצע האחרון שלו"
        )

    if finding.kind == "drawdown":
        window = evidence.get("window_days")
        span = f"השיא של {_ltr(window)} יום" if window else "השיא האחרון"
        return f"מחיר {symbol} נמצא {_ltr(signed_pct(evidence['drawdown_pct']))} מ{span}"

    if finding.kind == "allocation_drift":
        # Percentage points, as in English, and for the same reason.
        drift = Decimal(str(evidence["drift"])) * 100
        direction = "נמוך" if drift < 0 else "גבוה"
        points = _ltr(abs(drift).quantize(Decimal("0.1")))
        target = _ltr(signed_pct(evidence["target_weight"], 1).lstrip("+"))
        return f"משקל {symbol} {direction} ב־{points} נקודות אחוז ממשקל היעד של {target}"

    if finding.kind == "topic_move":
        return (
            f"{_own(symbol_of(finding))}: "
            f"שינוי ממוצע של {_ltr(signed_pct(evidence['basket_change_pct']))}, "
            f"{_ltr(sigma_of(evidence['z_score']))} סטיות תקן מהממוצע האחרון"
        )

    # A rule with no Hebrew template is caught by the parity test, not here.
    return f"{symbol}: {_ltr(finding.kind.replace('_', ' '))}"


def explanation_for(finding: Finding) -> str:
    evidence = finding.evidence
    symbol = _ltr(symbol_of(finding))
    currency = str(evidence.get("currency", ""))

    if finding.kind in ("price_move", "sigma_move"):
        parts = [
            f"מחיר {symbol} עבר מ־{_ltr(money(evidence['previous_price_minor'], currency))} "
            f"ל־{_ltr(money(evidence['price_minor'], currency))}, "
            f"שינוי של {_ltr(signed_pct(evidence['change_pct']))}."
        ]
        if finding.kind == "sigma_move":
            sigma = abs(Decimal(str(evidence["z_score"])).quantize(Decimal("0.1")))
            parts.append(
                f"ביחס ל־{_ltr(evidence['sample_size'])} התנועות היומיות האחרונות, "
                f"זו סטייה של {_ltr(sigma)} סטיות תקן מהממוצע."
            )
            if evidence.get("return_stdev_floor_applied"):
                parts.append(
                    "הנייר היה שקט במיוחד, ולכן הופעלה רצפה על אומדן התנודתיות, "
                    "והנתון הזה הוא חסם ולא מדידה."
                )
        return " ".join(parts)

    if finding.kind == "drawdown":
        return (
            f"המחיר האחרון של {symbol} היה {_ltr(money(evidence['price_minor'], currency))}, "
            f"{_ltr(signed_pct(evidence['drawdown_pct']).lstrip('+-'))} מתחת לשיא האחרון של "
            f"{_ltr(money(evidence['high_price_minor'], currency))}."
        )

    if finding.kind == "allocation_drift":
        return (
            f"משקל {symbol} בתיק הוא {_ltr(signed_pct(evidence['actual_weight'], 1).lstrip('+'))}, "
            f"לעומת משקל יעד של {_ltr(signed_pct(evidence['target_weight'], 1).lstrip('+'))}."
        )

    if finding.kind == "topic_move":
        return _topic_move_explanation(_own(symbol_of(finding)), evidence)

    return headline_for(finding)


def _topic_move_explanation(label: str, evidence: dict[str, object]) -> str:
    """The English version's order and counts: breadth, movers, how unusual."""
    parts = [
        f"מתוך {_ltr(evidence['members_moved'])} הנכסים של {label} שתומחרו ב־"
        f"{_ltr(evidence['session'])}, {_ltr(evidence['advancers'])} עלו ו־"
        f"{_ltr(evidence['decliners'])} ירדו; הממוצע משוקלל באופן שווה."
    ]
    movers = evidence.get("movers") or []
    if isinstance(movers, list) and movers:
        named = ", ".join(
            _ltr(f"{item['symbol']} {signed_pct(item['change_pct'])}") for item in movers
        )
        parts.append(f"התנועות הגדולות ביותר: {named}.")
    missing = evidence.get("not_priced_on_session") or []
    if isinstance(missing, list) and missing:
        parts.append(f"ללא מחיר באותו יום: {', '.join(_ltr(symbol) for symbol in missing)}.")
    parts.append(
        f"ביחס ל־{_ltr(evidence['sample_size'])} התנועות היומיות האחרונות של אותו סל, "
        f"זו סטייה של {_ltr(sigma_of(evidence['z_score']))} סטיות תקן מהממוצע."
    )
    if evidence.get("return_stdev_floor_applied"):
        parts.append(
            "הסל היה שקט במיוחד, ולכן הופעלה רצפה על אומדן התנודתיות, והנתון הזה הוא חסם ולא מדידה."
        )
    return " ".join(parts)
