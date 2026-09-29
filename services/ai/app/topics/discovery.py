"""Recurring phrases in collected headlines: where auto-discovery looks for themes (FR-11).

This module finds *candidates* and nothing else. It does not resolve them to
instruments, does not know what the user follows or rejected, and writes
nothing. The orchestrator takes the phrases, drops the ones rejection memory
suppresses, resolves the survivors through the ordinary `/topics/resolve`, and
proposes only the confident ones. Keeping the match rule on one side means it
is written once (`topicMatching.ts`), and resolving after filtering means a
theme the user rejected is not re-embedded every day.

**Why headlines, and from which feeds.** Two feeds reach this module. The
followed feed holds headlines that name something the user holds or follows
(decision 51); on its own it gave only themes *next to* the user's interests,
and on 2026-09-29 four companies were 95% of it. The market feed (decision 60,
`app/news/market_feed.py`) holds headlines about markets in general, mostly
linked to nothing followed, which is where a cross-company theme ("data
center", "bond yields") shows up as spread.

**What counts as recurring.** A phrase is a run of one to three content words
inside a headline. It recurs when it appears in at least `MIN_STORIES`
distinct *stories* from at least `MIN_SOURCES` distinct outlets within the
window. Stories, not articles, and not occurrences: a headline that says "AI"
twice is one article about AI, and one wire story republished by five outlets
is one story however many URLs it has. The ingestion's content hash
(`duplicate_of_id`) folds exact copies, but syndication usually changes the
headline a little - a site name appended ("... - Winnipeg Free Press"), a dash
swapped - so headlines are grouped into stories here as well (`same_story`).
Measured on the first real GDELT headlines (2026-09-27): counted by article,
one AI-safety wire story carried by three outlets made every word of its
headline a "recurring theme" ("alarm", "controlled", "openai sound"); counted
by story it is one story and none of them recur. Outlets are still counted,
because one publisher's repeated framing is a house style, not a theme.

**Only linked headlines and the market feed's are read**
(`load_window_headlines`). Other unlinked articles came from a search provider
that matched a name somewhere in the body; on 2026-09-27 68 of 77 stored
articles were those, and read as themes they were noise ("fiber" from a
breakfast-recipe headline).

**What is not a theme.** Generic newsroom and market vocabulary ("shares",
"record", "rises"), numbers, and the names of the instruments the headlines
were fetched for: "Apple" recurring across Apple's news says nothing new.
A shorter phrase is dropped when a longer one containing it was found in
exactly the same stories, so "data" and "centre" give way to "data centre";
and of several phrases found in exactly the same stories only one is kept,
because they are one candidate theme however many words it has. Past that,
a phrase inside a longer one found in most of the same stories is another
wording of it (`VARIANT_SHARE`): "agent safety", "safety platform" and "open
agent safety" are one launch, and one resolver call.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from itertools import chain

#: Distinct stories a phrase must appear in. Three, because two stories
#: sharing a phrase is routine coincidence in a day's financial news, and the
#: resolver call a phrase earns is not free. A product bound; nothing measured it.
MIN_STORIES = 3

#: Two headlines are one story when this share of the shorter one's content
#: words is in the longer one. High, because the cost of merging two real
#: stories is a missed theme and the cost of splitting one is a false one -
#: and syndication changes a headline by appending words, not by rewording it.
STORY_OVERLAP = 0.8

#: Below this many content words, headlines are one story only when their
#: words are identical: "Apple earnings" and "Apple earnings beat" are not a
#: republication of each other just because one contains the other.
MIN_STORY_WORDS = 4

#: A phrase is a wording of a longer phrase containing it, and one candidate
#: with it, when the longer one is in at least this share of its stories. On
#: the stored headlines of 2026-09-29 the contained pairs split at a gap: 0.75
#: and above were one story reworded ("agent safety" in "agent safety
#: platform", 0.92; "safety platform", 0.75), 0.71 and below a word with a life
#: of its own ("stop" in "stop ai"; "rogue ai" in "rogue ai agents", 0.54).
#: Without it, one product launch took seven of the eight resolve slots.
VARIANT_SHARE = 0.75

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
        # added from the first real headlines (2026-09-27): words that recurred
        # as "themes" because every kind of headline uses them
        "now", "here", "there", "these", "those", "also", "even", "very", "much",
        "many", "really", "actually", "need", "needs", "know", "see", "look",
        "looks", "take", "takes", "go", "goes", "going", "come", "comes", "back",
        "way", "ways", "thing", "things", "people", "time", "times", "like",
        "want", "wants", "should", "must", "does", "do", "did", "if", "so",
        "then", "only", "every", "any", "other", "own",
        # added from the first discovery run on title-matched headlines
        # (2026-09-28): everyday words that spent the resolve budget
        "buy", "pro", "use", "billion", "season", "prediction",
        # added from the 2026-09-29 run: the next resolve slots once one
        # company's news was dropped went to these
        "nasdaq", "us", "release", "releases",
        # the run after that (pr80, 2026-09-29): single words that resolved to
        # nothing and filled three of the eight slots
        "face", "ceo", "keep",
        # the market feed's first measurement (2026-09-29): "wall street" was
        # sixth in each of three 24-hour samples and names no theme
        "wall", "street",
    }
)  # fmt: skip


@dataclass(frozen=True, slots=True)
class Headline:
    article_id: str
    title: str
    source: str
    published_at: datetime | None
    #: Symbols of the instruments this headline is linked to. Empty for a market-feed
    #: headline linked to none, which counts against every phrase's lead instrument.
    instruments: tuple[str, ...] = ()


@dataclass(slots=True)
class Phrase:
    #: The folded words, which identify the phrase ("data centre" for both
    #: "data-centre" and "data centres").
    key: tuple[str, ...]
    #: The spelling the headlines used most often, lower-case.
    text: str
    #: Distinct article ids, in the order first seen.
    article_ids: list[str] = field(default_factory=list)
    #: The stories (`same_story` groups) those articles belong to.
    stories: set[int] = field(default_factory=set)
    sources: set[str] = field(default_factory=set)
    headlines: list[Headline] = field(default_factory=list)
    #: Articles linked to each instrument, by symbol.
    instruments: Counter[str] = field(default_factory=Counter)

    @property
    def article_count(self) -> int:
        return len(self.article_ids)

    @property
    def story_count(self) -> int:
        return len(self.stories)

    @property
    def source_count(self) -> int:
        return len(self.sources)

    @property
    def lead_instrument(self) -> tuple[str | None, int]:
        """The instrument most of this phrase's articles are linked to, and how many.

        Reported, not judged: whether a phrase is one company's news is the
        orchestrator's policy. The denominator is `article_count`, which counts
        articles linked to nothing, so a theme from a broader feed reads as
        spread however its few linked articles fall. Ties go to the first
        symbol alphabetically, so a rerun reports the same one.
        """
        if not self.instruments:
            return None, 0
        symbol, count = min(self.instruments.items(), key=lambda item: (-item[1], item[0]))
        return symbol, count


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


def story_words(title: str, names: set[tuple[str, ...]] | None = None) -> frozenset[str]:
    """The words a headline is compared by when grouping it into a story.

    Followed names are left out: headlines fetched for one company all share
    its name, and counting it would merge three different NuScale stories into
    one because each says "NuScale Power".
    """
    words = [w for w in tokens(title) if w not in GENERIC_WORDS and not w.isdigit() and len(w) > 1]
    kept = [w for run in _without_names(words, names or set()) for w in run]
    return frozenset(fold(w) for w in kept)


def same_story(a: frozenset[str], b: frozenset[str]) -> bool:
    """Are two headlines one story, republished? See `STORY_OVERLAP`."""
    return _one_story(len(a & b), len(a), len(b))


def _one_story(shared: int, size_a: int, size_b: int) -> bool:
    """`same_story` from the sizes alone: `shared` words in common, of `size_a` and `size_b`.

    Identical sets are the ones whose shared words are all of both.
    """
    smaller = min(size_a, size_b)
    if smaller < MIN_STORY_WORDS:
        return shared == size_a == size_b and smaller > 0
    return shared / smaller >= STORY_OVERLAP


def _fewest_shared(size: int) -> int:
    """The fewest shared words that can make a headline of `size` words one story with any other.

    Below `MIN_STORY_WORDS` only an identical headline, so all of them; at or
    above it the other headline has at least as many words (a shorter one would
    have to be identical), so the overlap share of the smallest such headline.
    A cheap test that rules out the stories sharing only a common word or two.
    """
    if size < MIN_STORY_WORDS:
        return size
    return math.ceil(STORY_OVERLAP * MIN_STORY_WORDS)


def group_stories(
    headlines: Sequence[Headline], names: set[tuple[str, ...]] | None = None
) -> list[int]:
    """A story number for each headline, in order. Compared with each story's first headline.

    Only stories whose first headline shares a word with this one are compared,
    and the words they share are counted from an index of word to story rather
    than by intersecting sets. `same_story` is never true for two headlines with
    no word in common, so the first match - the lowest story number - is the one
    a scan of every story would find. Measured on a week of the market feed
    (28,191 headlines, 2026-09-22..29), the whole of `recurring_phrases` took
    69 s comparing everything and 2.8 s through both indexes, with identical
    output; the orchestrator gives up on the AI service after 30 s.
    """
    sizes: list[int] = []
    by_word: dict[str, list[int]] = {}
    numbers: list[int] = []
    for headline in headlines:
        words = story_words(headline.title, names)
        # Counted in C: common words ("ai", "rate") list thousands of stories.
        shared = Counter(chain.from_iterable(by_word.get(word, ()) for word in words))
        floor = _fewest_shared(len(words))
        number = min(
            (
                i
                for i, count in shared.items()
                if count >= floor and _one_story(count, len(words), sizes[i])
            ),
            default=None,
        )
        if number is None:
            number = len(sizes)
            sizes.append(len(words))
            for word in words:
                by_word.setdefault(word, []).append(number)
        numbers.append(number)
    return numbers


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
    min_stories: int = MIN_STORIES,
    min_sources: int = MIN_SOURCES,
) -> list[Phrase]:
    """Phrases recurring across `headlines`, strongest first.

    Multi-word phrases first (`_rank` says why), then by distinct stories,
    outlets, articles, length and text - so the order is total and a rerun over
    the same headlines proposes the same things.
    """
    full_names, leading_words = excluded_keys(exclude_names)
    found: dict[tuple[str, ...], Phrase] = {}
    spellings: dict[tuple[str, ...], Counter[str]] = {}
    listed = list(headlines)

    for headline, story in zip(listed, group_stories(listed, full_names), strict=True):
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
                    phrase.instruments.update(set(headline.instruments))
                    phrase.stories.add(story)
                    phrase.sources.add(headline.source)
                    if len(phrase.headlines) < EVIDENCE_HEADLINES:
                        phrase.headlines.append(headline)
                    spellings[key][" ".join(run[start:end])] += 1

    def is_name(key: tuple[str, ...]) -> bool:
        return len(key) == 1 and key[0] in leading_words

    recurring = {
        key: phrase
        for key, phrase in found.items()
        if phrase.story_count >= min_stories
        and phrase.source_count >= min_sources
        and not is_name(key)
    }
    for phrase in recurring.values():
        # most_common keeps first-seen order among equals, so this is stable.
        phrase.text = spellings[phrase.key].most_common(1)[0][0]
    kept = _one_per_theme(list(recurring.values()))
    kept.sort(key=_rank)
    return kept


def _one_per_theme(phrases: list[Phrase]) -> list[Phrase]:
    """One phrase per group of wordings of the same theme.

    Two phrases are joined when they were found in exactly the same stories
    ("data" and "centre" with "data centre"), or when one contains the other and
    the longer one is in at least `VARIANT_SHARE` of the shorter one's stories.
    Joining is transitive, so "open agent safety" and "agent safety platform" -
    neither inside the other - meet through the "agent safety" both contain.
    Both rules run in one pass because the first would otherwise delete the
    phrase the second joins through.

    The phrases containing a given one are found through an index of every
    phrase's shorter runs of words (at most `MAX_PHRASE_WORDS` - 1 lengths, so a
    handful per phrase) rather than by comparing every pair: a week of the
    market feed has over 7,000 recurring phrases. The groups do not depend on the
    order the joins are made in, so the result is the same as the pairwise scan.
    """
    parent = list(range(len(phrases)))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    by_stories: dict[frozenset[int], int] = {}
    for i, phrase in enumerate(phrases):
        first = by_stories.setdefault(frozenset(phrase.stories), i)
        parent[root(i)] = root(first)
    containing: dict[tuple[str, ...], list[int]] = {}
    for j, longer in enumerate(phrases):
        runs = {
            longer.key[start : start + size]
            for size in range(1, len(longer.key))
            for start in range(len(longer.key) - size + 1)
        }
        for run in runs:
            containing.setdefault(run, []).append(j)
    for i, shorter in enumerate(phrases):
        for j in containing.get(shorter.key, ()):
            # Every headline holding the longer phrase holds the shorter one, so
            # the longer phrase's stories are a subset and this is their share.
            if len(phrases[j].stories) >= VARIANT_SHARE * len(shorter.stories):
                parent[root(i)] = root(j)
    groups: dict[int, Phrase] = {}
    for i, phrase in enumerate(phrases):
        current = groups.get(root(i))
        if current is None or _representative(phrase) < _representative(current):
            groups[root(i)] = phrase
    return list(groups.values())


def _representative(phrase: Phrase) -> tuple[bool, int, int, int, str]:
    """Which wording speaks for its group.

    The one in most stories, which is the wording the headlines agree on and
    puts the group where its reach says it belongs in the resolve budget; among
    equals the longest, because it says most. A single word only when nothing
    longer is in the group, for `_rank`'s reason.
    """
    return (
        len(phrase.key) == 1,
        -phrase.story_count,
        -len(phrase.key),
        -phrase.article_count,
        phrase.text,
    )


def _rank(phrase: Phrase) -> tuple[bool, int, int, int, int, str]:
    """Multi-word phrases first, then by stories, outlets, articles, length, text.

    Multi-word first because the orchestrator resolves only the first few, and a
    single word is a poor resolver query: on 2026-09-28 "ai" resolved to
    nothing and "chips" to potato-chip makers, while the one two-word phrase
    ("bytedance alibaba") was the only one pointing at a real theme. Ranked
    rather than filtered, so a strong single word still gets a turn when the
    multi-word phrases run out.
    """
    return (
        len(phrase.key) == 1,
        -phrase.story_count,
        -phrase.source_count,
        -phrase.article_count,
        -len(phrase.key),
        phrase.text,
    )
