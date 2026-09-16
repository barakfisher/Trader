"""Deciding which instruments an article is about.

Deterministic string matching, no model. Three rules make a link, in descending
order of how much they prove:

  1. `exchange_prefix` - "(NASDAQ: MSFT)", "XETRA: SAP". An exchange qualifier in
     front of a ticker is as explicit as financial prose gets.
  2. `cashtag` - "$AAPL". The sigil exists for exactly this purpose.
  3. `company_name` - the instrument's own `name`, normalised: "Apple Inc." is
     matched as "apple", "Vanguard S&P 500 ETF" as "vanguard s&p 500".

And one rule that deliberately does NOT make a link: **a bare ticker in prose.**
This is the trap the whole module is shaped around. "SMR" is NuScale Power's
ticker and it is also the industry's acronym for a small modular reactor, so a
regulatory notice about SMR designs that names no company would, under a bare
ticker rule, be filed as news about NuScale - and then cited as the reason a
holding moved. The same hazard is everywhere once you look: TAN, URA, CEG, ETH,
SAP and ALL are English words, acronyms or abbreviations before they are tickers.

The project's rule is that a wrong link is worse than a missing one: a missing
link costs an explanation we could have offered, while a wrong one produces a
confident explanation that is false, attached to real evidence, about real money.
So an uppercase token that merely looks like a ticker is logged and dropped. It
becomes a link only when something corroborates it - a sigil, an exchange
qualifier, or the company's name in the same article, in which case the link is
made by that rule and carries that rule's name.

Salience ranks the links on one article so the correlation step can pick the
instrument a story is mostly about. It is derived, not chosen: the base comes
from the strongest method that matched, with a bonus for a mention in the title
(a headline mention is what an article is about; a mention in the last paragraph
is context) and a small bonus for repetition. It ranks evidence; it is not a
probability and nothing should treat it as one.

Topic links (FR-11) are out of scope here: topics do not exist as user data until
Milestone 5, and `article_entities` models them as a free-text `topic_ref` so
this module can start emitting them without a schema change.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from app.core.logging import get_logger

log = get_logger("news.entities")

MatchMethod = Literal["cashtag", "exchange_prefix", "company_name"]

#: Base salience per method, ordered by how explicitly the method identifies an
#: instrument. Tuning values: tests assert against these names, never the numbers.
SALIENCE_EXCHANGE_PREFIX = 0.90
SALIENCE_CASHTAG = 0.85
SALIENCE_COMPANY_NAME = 0.70

#: Added once when the entity is mentioned in the title.
TITLE_SALIENCE_BONUS = 0.10

#: Added per mention beyond the first, capped. Repetition is weak evidence of
#: what a story is about - strong enough to break a tie between two instruments,
#: not strong enough to outrank an explicit ticker.
REPEAT_SALIENCE_BONUS = 0.02
REPEAT_SALIENCE_BONUS_MAX = 0.06

#: Aliases at least this long are matched case-insensitively; shorter ones are
#: matched exactly as written in the instrument's name. "SAP" the company is
#: three letters, and a case-insensitive three-letter alias matches "sap" the
#: verb. The cost of being strict is missing a lowercased mention in a headline;
#: the cost of being lax is a link to the wrong company.
MIN_CASE_INSENSITIVE_ALIAS_LENGTH = 4

#: Minimum length for the shortened "first word of the name" alias ("NuScale"
#: for NuScale Power Corporation). Below this the alias is an initialism and
#: carries no more information than a bare ticker.
MIN_SHORT_NAME_ALIAS_LENGTH = 4

#: Legal-form and vehicle-type tokens stripped from the tail of a name before it
#: becomes an alias. "Apple Inc." is written as "Apple" in prose roughly always.
_NAME_TAIL_NOISE = frozenset(
    {
        "ag",
        "co",
        "company",
        "corp",
        "corporation",
        "etf",
        "fund",
        "group",
        "holding",
        "holdings",
        "inc",
        "incorporated",
        "limited",
        "ltd",
        "nv",
        "plc",
        "sa",
        "se",
        "trust",
    }
)

#: Share-class suffixes ("Alphabet Inc. Class A"), stripped as a phrase.
_CLASS_SUFFIX = re.compile(r"\s+class\s+[a-z]\b", re.IGNORECASE)

#: Quote currencies that trail a crypto pair's display name ("Bitcoin USD").
_CRYPTO_NAME_TAIL = frozenset({"usd", "usdt", "usdc", "eur", "gbp", "btc", "eth"})

#: First words too generic to stand alone as a company alias. An article about
#: any Vanguard fund is not an article about one of them.
_GENERIC_FIRST_WORDS = frozenset(
    {
        "american",
        "atlantic",
        "capital",
        "energy",
        "first",
        "general",
        "global",
        "international",
        "invesco",
        "national",
        "new",
        "pacific",
        "partners",
        "power",
        "united",
        "vanguard",
    }
)

#: An uppercase token that could be a ticker. Used only to notice and log the
#: bare-ticker case, never to make a link.
_TICKER_SHAPED_TOKEN = re.compile(r"(?<![\w$])([A-Z]{2,5})(?![\w.-])")


@dataclass(frozen=True, slots=True)
class InstrumentRef:
    """The minimum an instrument has to tell us to be findable in prose.

    `instrument_id` is the database id when the caller has one and None when it
    does not - the fixture provider and the unit tests work from symbols alone.
    Carrying it through means the persistence layer never has to resolve symbols
    a second time.
    """

    symbol: str
    name: str | None = None
    asset_class: str = "unknown"
    instrument_id: str | None = None


@dataclass(frozen=True, slots=True)
class EntityLink:
    """One article-to-instrument link, with the reason it was made."""

    symbol: str
    salience: float
    match_method: MatchMethod
    matched_text: str
    mentions: int
    in_title: bool
    instrument_id: str | None = None
    entity_kind: Literal["instrument", "topic"] = "instrument"


@dataclass(frozen=True, slots=True)
class _Alias:
    """One compiled way of spelling one instrument."""

    pattern: re.Pattern[str]
    method: MatchMethod


class EntityMatcher:
    """Matches article text against a fixed instrument universe.

    Built once per run from the instruments the user holds (plus, later, the ones
    their topics resolve to) and reused for every article, because compiling a
    few dozen patterns per article would dominate the cost of the pass.

    The universe is a closed set by design. Recognising companies we do not hold
    is a named-entity-recognition problem and belongs to topic discovery (FR-11),
    not here: this pass answers "does this article concern my portfolio?", and
    for that question every answer lives in the instruments table.
    """

    def __init__(self, instruments: list[InstrumentRef]) -> None:
        self._instruments = instruments
        self._aliases: dict[str, list[_Alias]] = {
            instrument.symbol.upper(): _build_aliases(instrument) for instrument in instruments
        }
        self._known_tickers = {
            form for instrument in instruments for form in _ticker_forms(instrument.symbol)
        }

    @property
    def symbols(self) -> list[str]:
        return [instrument.symbol.upper() for instrument in self._instruments]

    def match(self, title: str, body: str) -> list[EntityLink]:
        """Links for one article, strongest first.

        Pure: `title` and `body` are the whole world this function sees. Returns
        an empty list for an article about nothing we hold, which is the normal
        case for most of a news feed and must stay cheap and silent.
        """
        links: list[EntityLink] = []
        for instrument in self._instruments:
            link = self._match_one(instrument, title, body)
            if link is not None:
                links.append(link)

        self._log_unconfirmed_tickers(title, body, {link.symbol for link in links})
        # Ties broken by symbol so the order is total and a stored ranking does
        # not depend on dictionary iteration order.
        return sorted(links, key=lambda link: (-link.salience, link.symbol))

    def _match_one(self, instrument: InstrumentRef, title: str, body: str) -> EntityLink | None:
        symbol = instrument.symbol.upper()
        best: tuple[float, MatchMethod, str, int, bool] | None = None

        for alias in self._aliases[symbol]:
            title_hits = alias.pattern.findall(title)
            body_hits = alias.pattern.findall(body)
            mentions = len(title_hits) + len(body_hits)
            if mentions == 0:
                continue
            in_title = bool(title_hits)
            matched_text = (title_hits or body_hits)[0]
            salience = _salience(alias.method, mentions=mentions, in_title=in_title)
            candidate = (salience, alias.method, matched_text, mentions, in_title)
            if best is None or candidate[0] > best[0]:
                best = candidate

        if best is None:
            return None
        salience, method, matched_text, mentions, in_title = best
        return EntityLink(
            symbol=symbol,
            salience=salience,
            match_method=method,
            matched_text=matched_text,
            mentions=mentions,
            in_title=in_title,
            instrument_id=instrument.instrument_id,
        )

    def _log_unconfirmed_tickers(self, title: str, body: str, linked: set[str]) -> None:
        """Record ticker-shaped words we refused to link, so the refusals are visible.

        Without this the module's central decision is invisible: an article that
        should have linked and did not looks exactly like an article that had
        nothing to link. One log line turns "why is there no news on SMR?" into a
        question with an answer.
        """
        candidates = {
            token
            for token in _TICKER_SHAPED_TOKEN.findall(f"{title} {body}")
            if token in self._known_tickers and token not in linked
        }
        for token in sorted(candidates):
            log.info("news.entities.unconfirmed_ticker", token=token)


def _salience(method: MatchMethod, *, mentions: int, in_title: bool) -> float:
    base = {
        "exchange_prefix": SALIENCE_EXCHANGE_PREFIX,
        "cashtag": SALIENCE_CASHTAG,
        "company_name": SALIENCE_COMPANY_NAME,
    }[method]
    repeat = min(REPEAT_SALIENCE_BONUS * (mentions - 1), REPEAT_SALIENCE_BONUS_MAX)
    total = base + repeat + (TITLE_SALIENCE_BONUS if in_title else 0.0)
    # Four decimals to match `article_entities.salience numeric(5, 4)`; rounding
    # at the boundary rather than in the database keeps the stored value equal to
    # the value the code compared.
    return round(min(total, 1.0), 4)


def _ticker_forms(symbol: str) -> set[str]:
    """Ways this symbol is written as a ticker.

    A suffixed symbol has two: "SAP.DE" trades as "SAP" in prose and "BTC-USD"
    as "BTC". The suffix is our provider's notation, not the press's.
    """
    upper = symbol.strip().upper()
    forms = {upper}
    base = re.split(r"[.\-]", upper)[0]
    if base:
        forms.add(base)
    return forms


def _build_aliases(instrument: InstrumentRef) -> list[_Alias]:
    aliases: list[_Alias] = []
    for form in sorted(_ticker_forms(instrument.symbol)):
        escaped = re.escape(form)
        # "(NASDAQ: MSFT)", "NYSE: SMR". The exchange token is required to be
        # uppercase, which is what separates it from any prose ending in a colon.
        aliases.append(
            _Alias(
                pattern=re.compile(rf"\b[A-Z]{{2,10}}\s*:\s*{escaped}\b"),
                method="exchange_prefix",
            )
        )
        # "$AAPL". Case-insensitive: the sigil already removes the ambiguity.
        aliases.append(
            _Alias(
                pattern=re.compile(rf"\${escaped}\b", re.IGNORECASE),
                method="cashtag",
            )
        )

    for alias in _name_aliases(instrument):
        flags = re.IGNORECASE if len(alias) >= MIN_CASE_INSENSITIVE_ALIAS_LENGTH else 0
        # Lookarounds rather than \b: an alias can end in a non-word character
        # ("vanguard s&p 500"), and \b next to one asserts the opposite of what
        # is meant. Internal whitespace is flexible so a line break inside the
        # name still matches.
        body = r"\s+".join(re.escape(token) for token in alias.split())
        aliases.append(
            _Alias(
                pattern=re.compile(rf"(?<!\w){body}(?!\w)", flags),
                method="company_name",
            )
        )
    return aliases


def _name_aliases(instrument: InstrumentRef) -> list[str]:
    """Spellings of the instrument's name that plausibly appear in prose."""
    core = _core_name(instrument)
    if not core:
        return []
    aliases = [core]

    first, _, rest = core.partition(" ")
    if (
        rest
        and instrument.asset_class == "equity"
        and len(first) >= MIN_SHORT_NAME_ALIAS_LENGTH
        and first.lower() not in _GENERIC_FIRST_WORDS
    ):
        # "NuScale" for NuScale Power Corporation, because the press drops the
        # rest. Only for single companies: the first word of a fund's name is its
        # issuer, and "Vanguard" is thirty funds.
        aliases.append(first)
    return aliases


def _core_name(instrument: InstrumentRef) -> str:
    """The instrument's name with the parts prose leaves out removed.

    Case is preserved, because whether an alias is matched case-sensitively
    depends on how it is written in the instruments table.
    """
    name = (instrument.name or "").strip()
    if not name:
        return ""
    name = _CLASS_SUFFIX.sub("", name, count=1)

    tokens = name.split()
    tail_noise = _NAME_TAIL_NOISE | (
        _CRYPTO_NAME_TAIL if instrument.asset_class == "crypto" else frozenset()
    )
    while len(tokens) > 1 and tokens[-1].strip(".,").lower() in tail_noise:
        tokens.pop()
    return " ".join(tokens).strip(" .,")
