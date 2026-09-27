"""Recurring phrases in collected headlines: where auto-discovery looks for themes (FR-11).

This module finds *candidates* and nothing else. It does not resolve them to
instruments, does not know what the user follows or rejected, and writes
nothing. The orchestrator takes the phrases, drops the ones rejection memory
suppresses, resolves the survivors through the ordinary `/topics/resolve`, and
proposes only the confident ones. Keeping the match rule on one side means it
is written once (`topicMatching.ts`), and resolving after filtering means a
theme the user rejected is not re-embedded every day.

**Why headlines, and what that limits.** News is collected for the instruments
the user holds or follows, never the universe (decision 51), so every headline
here was fetched because it named something the user already cares about. A
phrase that recurs across them is a theme *next to* the user's interests - the
"data centres" in stories about Nvidia and a utility - not one from a corner of
the market they have never looked at. That is a limit of the source, stated
rather than hidden.

**What counts as recurring.** A phrase is a run of one to three content words
inside a headline. It recurs when it appears in at least `MIN_ARTICLES`
distinct articles from at least `MIN_SOURCES` distinct outlets within the
window. Articles, not occurrences, because a headline that says "AI" twice is
one article about AI; outlets, because one publisher's repeated framing is a
house style, not a theme. Syndicated copies are already folded by the
ingestion's content hash (`duplicate_of_id`) and are not read.

**What is not a theme.** Generic newsroom and market vocabulary ("shares",
"record", "rises"), numbers, and the names of the instruments the headlines
were fetched for: "Apple" recurring across Apple's news says nothing new.
A shorter phrase is dropped when a longer one containing it was found in
exactly the same articles, so "data" and "centre" give way to "data centre".
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime

#: Distinct articles a phrase must appear in. Three, because two headlines
#: sharing a phrase is routine coincidence in a day's financial news, and the
#: resolver call a phrase earns is not free. A product bound; nothing measured it.
MIN_ARTICLES = 3

#: Distinct outlets among those articles.
MIN_SOURCES = 2

#: The longest phrase considered, in words.
MAX_PHRASE_WORDS = 3

#: How many headlines are quoted per phrase as its evidence.
EVIDENCE_HEADLINES = 5

_TOKEN = re.compile(r"[a-z0-9]+(?:'[a-z]+)?")

#: Words that can never start, end or sit inside a theme: grammar, and the
#: vocabulary every market headline uses whatever it is about.
GENERIC_WORDS = frozenset(
    {
        # grammar
        "a", "an", "and", "the", "of", "in", "on", "for", "to", "with", "its", "it",
        "is", "are", "as", "by", "or", "at", "from", "that", "this", "after", "amid",
        "over", "into", "about", "than", "but", "be", "been", "was", "were", "has",
        "have", "had", "will", "would", "could", "can", "may", "might", "not", "no",
        "new", "why", "how", "what", "who", "which", "when", "where", "their", "his",
        "her", "they", "we", "you", "i", "our", "your", "more", "most", "less", "up",
        "down", "out", "off", "again", "still", "just", "vs", "via", "per", "all",
        "one", "two", "three", "first", "second", "third", "next", "last", "some",
        "s", "says", "said", "say", "set", "sets", "gets", "get", "make", "makes",
        # market and newsroom vocabulary
        "stock", "stocks", "share", "shares", "market", "markets", "price", "prices",
        "fund", "funds", "investor", "investors", "trading", "trader", "traders",
        "report", "reports", "record", "deal", "deals", "plan", "plans", "rise",
        "rises", "rose", "rising", "fall", "falls", "fell", "falling", "gain",
        "gains", "loss", "losses", "high", "higher", "low", "lower", "slump",
        "slumps", "rally", "rallies", "jump", "jumps", "drop", "drops", "surge",
        "surges", "slide", "slides", "climb", "climbs", "ease", "eases", "lifts",
        "lift", "raises", "raise", "cuts", "cut", "trims", "trim", "wins", "win",
        "warns", "warn", "names", "signs", "inks", "hits", "hit", "draws", "lands",
        "year", "years", "week", "weeks", "day", "days", "today", "month", "months",
        "quarter", "quarters", "q1", "q2", "q3", "q4", "results", "earnings",
        "outlook", "update", "news", "analyst", "analysts", "company", "companies",
        "inc", "corp", "ltd", "plc", "group", "top", "best", "big", "biggest",
    }
)  # fmt: skip


@dataclass(frozen=True, slots=True)
class Headline:
    article_id: str
    title: str
    source: str
    published_at: datetime | None


@dataclass(slots=True)
class Phrase:
    #: The folded words, which identify the phrase ("data centre" for both
    #: "data-centre" and "data centres").
    key: tuple[str, ...]
    #: The spelling the headlines used most often, lower-case.
    text: str
    #: Distinct article ids, in the order first seen.
    article_ids: list[str] = field(default_factory=list)
    sources: set[str] = field(default_factory=set)
    headlines: list[Headline] = field(default_factory=list)

    @property
    def article_count(self) -> int:
        return len(self.article_ids)

    @property
    def source_count(self) -> int:
        return len(self.sources)


def fold(word: str) -> str:
    """Crude plural folding, the resolver's rule: 'centres' meets 'centre'."""
    return word[:-1] if len(word) > 3 and word.endswith("s") and not word.endswith("ss") else word


def tokens(text: str) -> list[str]:
    """Lower-case word tokens; a possessive "'s" is dropped with its apostrophe."""
    return [re.sub(r"'s$", "", t) for t in _TOKEN.findall(text.lower().replace("’", "'"))]


def _runs(words: Sequence[str]) -> Iterable[list[str]]:
    """Maximal runs of content words: the stretches a theme can come from."""
    run: list[str] = []
    for word in words:
        if word in GENERIC_WORDS or word.isdigit() or len(word) < 2:
            if run:
                yield run
            run = []
        else:
            run.append(word)
    if run:
        yield run


def _ngrams(run: Sequence[str]) -> Iterable[tuple[int, int]]:
    for size in range(1, MAX_PHRASE_WORDS + 1):
        for start in range(len(run) - size + 1):
            yield start, start + size


def _contains(longer: tuple[str, ...], shorter: tuple[str, ...]) -> bool:
    n = len(shorter)
    return any(longer[i : i + n] == shorter for i in range(len(longer) - n + 1))


def _without_names(run: list[str], names: set[tuple[str, ...]]) -> Iterable[list[str]]:
    """`run` split around every followed name in it, the name itself removed.

    Removed before phrases are built, not filtered after: filtering would drop
    "nuscale power" but still count the "power" inside it towards a theme.
    """
    folded = [fold(w) for w in run]
    start = 0
    i = 0
    while i < len(run):
        match = max(
            (len(n) for n in names if tuple(folded[i : i + len(n)]) == n),
            default=0,
        )
        if match:
            if i > start:
                yield run[start:i]
            i += match
            start = i
        else:
            i += 1
    if start < len(run):
        yield run[start:]


def excluded_keys(names: Iterable[str]) -> tuple[set[tuple[str, ...]], set[str]]:
    """What the followed instruments' own names rule out.

    Returns the full names, which are cut out of every headline before phrases
    are built ("NuScale Power wins an order" contributes "order", not "power"),
    and their leading words, which are dropped as one-word phrases because
    prose shortens names ("Constellation inks a deal"). Only the leading word:
    the rest of a name is often a real theme, and "NuScale Power" must not make
    "power" unproposable when other headlines are about power.
    """
    full: set[tuple[str, ...]] = set()
    leading: set[str] = set()
    for name in names:
        words = tuple(fold(w) for w in tokens(name))
        if not words:
            continue
        full.add(words)
        leading.add(words[0])
    return full, leading


def recurring_phrases(
    headlines: Iterable[Headline],
    *,
    exclude_names: Iterable[str] = (),
    min_articles: int = MIN_ARTICLES,
    min_sources: int = MIN_SOURCES,
) -> list[Phrase]:
    """Phrases recurring across `headlines`, strongest first.

    Ordered by distinct articles, then distinct outlets, then longer phrase
    first, then alphabetically - so the order is total and a rerun over the
    same headlines proposes the same things.
    """
    full_names, leading_words = excluded_keys(exclude_names)
    found: dict[tuple[str, ...], Phrase] = {}
    spellings: dict[tuple[str, ...], Counter[str]] = {}

    for headline in headlines:
        seen_here: set[tuple[str, ...]] = set()
        for whole in _runs(tokens(headline.title)):
            for run in _without_names(whole, full_names):
                folded = [fold(w) for w in run]
                for start, end in _ngrams(folded):
                    key = tuple(folded[start:end])
                    if key in seen_here:
                        continue
                    seen_here.add(key)
                    phrase = found.get(key)
                    if phrase is None:
                        phrase = found[key] = Phrase(key=key, text="")
                        spellings[key] = Counter()
                    phrase.article_ids.append(headline.article_id)
                    phrase.sources.add(headline.source)
                    if len(phrase.headlines) < EVIDENCE_HEADLINES:
                        phrase.headlines.append(headline)
                    spellings[key][" ".join(run[start:end])] += 1

    def is_name(key: tuple[str, ...]) -> bool:
        return len(key) == 1 and key[0] in leading_words

    recurring = {
        key: phrase
        for key, phrase in found.items()
        if phrase.article_count >= min_articles
        and phrase.source_count >= min_sources
        and not is_name(key)
    }
    # A sub-phrase found in exactly the articles of a longer phrase adds nothing.
    kept = [
        phrase
        for key, phrase in recurring.items()
        if not any(
            len(other) > len(key)
            and _contains(other, key)
            and set(recurring[other].article_ids) == set(phrase.article_ids)
            for other in recurring
        )
    ]
    for phrase in kept:
        # most_common keeps first-seen order among equals, so this is stable.
        phrase.text = spellings[phrase.key].most_common(1)[0][0]
    kept.sort(key=lambda p: (-p.article_count, -p.source_count, -len(p.key), p.text))
    return kept
