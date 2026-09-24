"""A free-text topic in, candidate instruments out - each with a reason (FR-10).

"Uranium & Nuclear Energy" becomes instruments whose business is that, for the
user to confirm. Nothing here subscribes to anything: resolution proposes, the
user decides. Five steps, each for a measured reason.

1. **Match on what a business does, not its sector label.** Yahoo files NuScale
   under "Specialty Industrial Machinery" and Palantir under "Software -
   Infrastructure"; only the description says reactors and defence. The topic
   is embedded and compared with each profile's embedded description.

2. **Admit by similarity, then order by size.** The first eval run passed 6 of
   20 and the failures had one shape: specialists outranked the companies a
   person means. NVIDIA describes itself across segments and ranked 64th for "AI
   Hardware & Semiconductors" under smaller chip designers; Newmont, the largest
   gold miner, ranked 15th for "gold mining" in the fitting set. So similarity
   decides only *whether* an instrument is on topic, and size decides the order
   among those that are. The gate is two conditions because neither alone held
   on the fitting topics: within `BAND` of the best match, and above
   `CANDIDATE_FLOOR`. The gate is also what stops a giant climbing a list it
   barely belongs to: NVIDIA scores 0.30 for "video game publishers", far
   outside the band, so it is never there to be promoted.

3. **Ask when the candidates mean different things.** A word with two unrelated
   market meanings admits two unrelated kinds of business. The admitted
   equities are grouped by how alike their own descriptions are
   (`app/topics/meanings.py`); two or more real groups make the topic
   ambiguous, and each group is offered as a separate interpretation instead of
   one list that mixes them. ETFs are attached to the nearest group rather than
   grouped, because every fund describes itself in the same register ("The fund
   invests...") and would otherwise form a "meaning" of its own on every topic.

4. **The rationale is quoted, never written** - the description sentence sharing
   the most words with the topic. A model could write a nicer one, and could
   also write one that is plausible and false about a real company.

5. **What the matching ETFs hold is a second route in** (M5 slice 2). A company
   whose description is too broad to sit near any one theme - Palantir scores
   0.32 against defense, Amazon ranks below 100th for e-commerce - is still
   *held* by the funds that are about that theme. Up to `ETF_SOURCES` ETFs
   similar to the topic (above `ETF_SOURCE_FLOOR`) whose own holdings are about
   it (`COHERENCE_BAND`) are its sources; their
   matched top holdings join the candidates without passing the similarity
   gate, because the holding is the evidence. Every candidate carries
   `held_by`, so "held by SHLD (10.8% of the fund)" is checkable in the same
   way a quoted sentence is.

Confidence is a band, not a number, for the reason `/ask` learned: a cosine of
0.43 is not a probability. The whole-topic verdict reuses
`app/ask/relevance.judge`, including its abstention on the fixture embedder.
Every threshold here was fitted to `data/eval/topics.json`'s
`threshold_fitting_topics`, never to the eval's own cases.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

from sqlalchemy.engine import Connection

from app.ask.relevance import Relevance, RelevanceJudgement, judge
from app.corpus.embeddings import BaseEmbedder
from app.corpus.retrieval import _NON_SEMANTIC_MODELS
from app.topics.meanings import group, nearest_group
from app.universe.profiles import (
    Holder,
    ProfileMatch,
    holdings_of,
    profiles_by_id,
    search_profiles,
)

#: How many candidates each interpretation offers the user to confirm. A
#: readability choice, fixed before the eval was first run so the eval could not
#: pull it upward: fitting topics have between ~4 (cruise lines) and 30+ (gold
#: miners) plainly relevant instruments, so no count is "right", and fifteen is
#: what a person can read and tick through.
CANDIDATE_LIMIT = 15

#: How many nearest profiles are considered before gating. Deep enough that the
#: band, not this number, decides membership: the flattest fitting topics
#: ("data center real estate", "mining") admit 60+ within the band.
POOL = 200

#: Best-match cosine below which the universe is judged to hold nothing about
#: the topic. Measured on `threshold_fitting_topics` against name-stripped
#: profiles (`app/universe/matching_text.py`; universe as of 2026-09-24T08:13Z,
#: openai/text-embedding-3-small):
#:
#:     lowest in-domain    0.406  ("railroads")
#:     highest out-domain  0.286  ("best hiking trails in patagonia")
#:     separation          0.120
#:
#: Before names were stripped the separation was 0.018, and the out-of-domain
#: maximum was "how tall is mount everest" matching Everest Group on its name:
#: most of what looked like a thin boundary was name collisions. The floor sits
#: in the gap nearer the out-of-domain end, as `/ask`'s does, so a real topic
#: is admitted in preference to a nonsense one being refused.
NOTHING_BELOW = 0.32

#: A candidate at or above this is presented as a strong match, below it as
#: weak. On the fitting topics nearly everything above it is plainly on-topic;
#: below it lists shade into neighbours (Copa Airlines under cruise lines).
STRONG_ABOVE = 0.45

#: The gate: a candidate is on topic if its similarity is within `BAND` of the
#: best match and at least `CANDIDATE_FLOOR`. Labelled on the fitting topics:
#: every real railroad scores 0.343-0.406 and a bank follows at 0.313, so a band
#: alone admits it - hence the floor; a narrower band (0.08) starves compact
#: topics (one gene-editing company, two cruise lines) - hence 0.11.
BAND = 0.11
CANDIDATE_FLOOR = 0.33

#: At most this many admitted matches, most similar first, go on to be ordered
#: by size. Flat topics admit dozens within the band - "data center real
#: estate" 60+, because every REIT matches "real estate" - and ordering all of
#: them by size would put the largest generic REIT first. Every compact fitting
#: topic fits inside it (gold mining 22, oil and gas 22, home builders 21).
MAX_ADMITTED = 30

#: Two groups of candidates are different meanings of the topic when their
#: descriptions are on average less alike than this. Fitted before profile
#: names were stripped: facets of one industry (E&P vs oilfield services,
#: restaurants vs food distributors) 0.405-0.430; bitcoin miners vs metal
#: miners 0.359. **Unverified since**: on name-stripped profiles no fitting
#: topic splits at all - bitcoin miners now describe themselves close enough to
#: metal miners ("mining") to merge - so the fitting set has no positive
#: example left, and this value is carried over rather than re-derived.
MEANINGS_SPLIT_BELOW = 0.39

#: How many of the ETFs most similar to a topic act as its sources, and how
#: similar an ETF must be to count. Labelled on `threshold_fitting_topics`
#: (universe as of 2026-09-24T12:04Z): ETFs that are about the topic score
#: 0.306-0.509 (JETS 0.450 for airlines, ESPO 0.327 for video games, XTN 0.306
#: for shipping); the best unrelated ETF for a real topic scores 0.269 (an MLP
#: fund for railroads) and the best for a nonsense one 0.262. The floor sits in
#: that gap. Three, because gold, oil, gene editing, home builders and
#: pipelines each have three or four genuinely thematic funds.
#:
#: Known weakness, measured and not tuned away: "data center real estate" finds
#: DTCR (0.446) and then an industrial REIT fund (0.440) and a broad real-estate
#: fund (0.429) - the topic's second noun matched on its own. No floor separates
#: them from DTCR, so their holdings come in too.
ETF_SOURCES = 3
ETF_SOURCE_FLOOR = 0.29

#: A fund is only a source if what it holds is about the topic: the mean
#: similarity of its matched holdings must be within `COHERENCE_BAND` of the
#: topic's best match. Without it, broad sector funds that happen to match a
#: topic's words bring their giants in - BBH put Amgen and Gilead under "gene
#: editing biotech", XHB put Home Depot under "home builders", IYR put
#: Welltower under "data center real estate" - and size ordering puts those
#: first. Labelled on the fitting topics, this keeps every gold fund, JETS,
#: ESPO, ITB, DTCR and the pipeline funds, and drops BBH/PBE/IDNA/XBI, XHB/PKB,
#: IYR and WGMI (a bitcoin-mining fund now holding AI-cloud companies). It does
#: not drop INDS (industrial REITs) for "data center real estate": the topic's
#: second noun is genuinely what that fund holds.
COHERENCE_BAND = 0.13

#: How many of the ETFs above the floor are examined for coherence before the
#: first `ETF_SOURCES` coherent ones are kept.
ETF_SOURCE_CANDIDATES = 6

#: A group needs this many equities to count as a meaning; a lone outlier is
#: attached to the nearest real group rather than offered as an interpretation.
MIN_MEANING_SIZE = 2

_SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[A-Z])")
_WORD = re.compile(r"[a-z0-9]+")
#: Words that make any two sentences look related.
_STOPWORDS = frozenset(
    {
        "a", "an", "and", "the", "of", "in", "on", "for", "to", "with", "its", "it",
        "is", "are", "as", "by", "or", "at", "from", "that", "this",
        "company", "companies", "inc", "corporation", "provides", "offers",
    }
)  # fmt: skip


@dataclass(frozen=True, slots=True)
class TopicCandidate:
    symbol: str
    name: str | None
    asset_class: str
    sector: str | None
    industry: str | None
    similarity: float
    #: Market cap (equity) or net assets (ETF), minor units; None if unknown.
    size_minor: int | None
    #: `confident` or `weak`, by `STRONG_ABOVE`.
    confidence: Relevance
    #: A sentence from the instrument's own description, verbatim.
    rationale: str
    #: The topic's source ETFs that hold this instrument, largest weight first.
    #: Empty when it was found by its description alone.
    held_by: tuple[Holder, ...] = ()


@dataclass(frozen=True, slots=True)
class Interpretation:
    #: The most common Yahoo industry among the group's equities - a label
    #: from the data, not a phrase anyone wrote.
    label: str | None
    #: At most `CANDIDATE_LIMIT`: largest first when the embedder is semantic.
    candidates: list[TopicCandidate]


@dataclass(frozen=True, slots=True)
class TopicResolution:
    topic: str
    judgement: RelevanceJudgement
    #: One entry when the topic means one thing; several when the candidates
    #: split into unrelated businesses and the user should choose. Empty when
    #: the judgement is `none`: offering the least-bad rows for a topic nothing
    #: is about is the failure the floor exists to prevent.
    interpretations: list[Interpretation]
    embedding_model: str
    vector_is_semantic: bool

    @property
    def resolved(self) -> bool:
        return self.judgement.is_answerable and bool(self.interpretations)

    @property
    def ambiguous(self) -> bool:
        return len(self.interpretations) > 1


def _words(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if w not in _STOPWORDS}


def _stem(word: str) -> str:
    """Crude plural folding, enough that 'drugs' meets 'drug' and 'chips' meets 'chip'."""
    return word[:-1] if len(word) > 3 and word.endswith("s") else word


def rationale(topic: str, description: str) -> str:
    """The description sentence sharing the most words with `topic`, verbatim."""
    sentences = [s.strip() for s in _SENTENCE.split(description) if s.strip()]
    if not sentences:
        return description.strip()
    wanted = {_stem(w) for w in _words(topic)}

    def overlap(sentence: str) -> int:
        return len(wanted & {_stem(w) for w in _words(sentence)})

    best = max(sentences, key=overlap)  # max keeps the first of equals
    return best if overlap(best) else sentences[0]


def admit(matches: list[ProfileMatch]) -> list[ProfileMatch]:
    """The matches on topic: within `BAND` of the best, above `CANDIDATE_FLOOR`,
    at most `MAX_ADMITTED` of them. `matches` must be most similar first."""
    if not matches:
        return []
    line = max(CANDIDATE_FLOOR, matches[0].similarity - BAND)
    return [m for m in matches if m.similarity >= line][:MAX_ADMITTED]


def source_candidates(matches: list[ProfileMatch]) -> list[ProfileMatch]:
    """The ETFs close enough to the topic to be examined as sources, closest first."""
    etfs = [m for m in matches if m.asset_class == "etf" and m.similarity >= ETF_SOURCE_FLOOR]
    return etfs[:ETF_SOURCE_CANDIDATES]


def coherent(
    candidates: list[ProfileMatch],
    holding_similarities: dict[str, list[float]],
    *,
    best: float,
) -> list[ProfileMatch]:
    """The first `ETF_SOURCES` candidates whose holdings are about the topic.

    `holding_similarities` maps an ETF's symbol to the topic similarity of each
    of its matched holdings. A fund with no matched holding says nothing and is
    not a source.
    """
    kept = []
    for etf in candidates:
        scores = holding_similarities.get(etf.symbol, [])
        if scores and sum(scores) / len(scores) >= best - COHERENCE_BAND:
            kept.append(etf)
    return kept[:ETF_SOURCES]


def split_meanings(admitted: list[ProfileMatch]) -> list[list[ProfileMatch]]:
    """Admitted matches partitioned into meanings, most relevant meaning first.

    Equities are grouped by description similarity; groups smaller than
    `MIN_MEANING_SIZE` and every ETF are then attached to the nearest real
    group. With fewer than two real groups the topic has one meaning and
    everything admitted is in it.
    """
    equities = [m for m in admitted if m.asset_class != "etf"]
    groups = group([m.embedding for m in equities], split_below=MEANINGS_SPLIT_BELOW)
    real = [g for g in groups if len(g) >= MIN_MEANING_SIZE]
    if len(real) < 2:
        return [admitted]

    meanings: list[list[ProfileMatch]] = [[equities[i] for i in g] for g in real]
    anchors = [m.embedding for m in equities]
    strays = [equities[i] for g in groups if len(g) < MIN_MEANING_SIZE for i in g]
    strays += [m for m in admitted if m.asset_class == "etf"]
    for match in strays:
        meanings[nearest_group(match.embedding, real, anchors)].append(match)
    return sorted(meanings, key=lambda ms: -max(m.similarity for m in ms))


def _by_size(match: ProfileMatch) -> tuple[bool, int, float]:
    # Unknown size sorts last, never as zero-sized-but-present.
    return (match.size_minor is None, -(match.size_minor or 0), -match.similarity)


def _interpretation(
    topic: str,
    meaning: list[ProfileMatch],
    *,
    limit: int,
    semantic: bool,
    held: dict[str, list[Holder]],
) -> Interpretation:
    industries = Counter(m.industry for m in meaning if m.asset_class != "etf" and m.industry)
    ordered = sorted(meaning, key=_by_size) if semantic else meaning
    return Interpretation(
        label=industries.most_common(1)[0][0] if industries else None,
        candidates=[
            TopicCandidate(
                symbol=m.symbol,
                name=m.name,
                asset_class=m.asset_class,
                sector=m.sector,
                industry=m.industry,
                similarity=m.similarity,
                size_minor=m.size_minor,
                confidence=Relevance.CONFIDENT
                if semantic and m.similarity >= STRONG_ABOVE
                else Relevance.WEAK,
                rationale=rationale(topic, m.description),
                held_by=tuple(held.get(m.instrument_id, ())),
            )
            for m in ordered[:limit]
        ],
    )


async def resolve_topic(
    connection: Connection,
    embedder: BaseEmbedder,
    topic: str,
    *,
    limit: int = CANDIDATE_LIMIT,
) -> TopicResolution:
    is_semantic = embedder.model not in _NON_SEMANTIC_MODELS
    embedding = await embedder.embed_query(topic)
    matches = search_profiles(connection, embedding=embedding, model=embedder.model, limit=POOL)
    judgement = judge(
        matches[0].similarity if matches else None,
        vector_is_semantic=is_semantic,
        refuse_below=NOTHING_BELOW,
        confident_above=STRONG_ABOVE,
    )

    interpretations: list[Interpretation] = []
    if judgement.is_answerable and matches:
        # The gate, the size ordering and the grouping are all calibrated in
        # cosine from a real model. The fixture's similarities count shared
        # words and mean nothing on that scale, so on it resolution abstains
        # the way `judge` does: similarity order, one meaning, every candidate
        # weak.
        held: dict[str, list[Holder]] = {}
        if is_semantic:
            candidates = admit(matches)
            examined = source_candidates(matches)
            offered = holdings_of(connection, [etf.instrument_id for etf in examined])
            profiles = {
                p.instrument_id: p
                for p in profiles_by_id(
                    connection, ids=list(offered), embedding=embedding, model=embedder.model
                )
            }
            by_etf: dict[str, list[float]] = {}
            for instrument_id, holders in offered.items():
                if instrument_id in profiles:
                    for holder in holders:
                        by_etf.setdefault(holder.etf, []).append(profiles[instrument_id].similarity)
            chosen = {etf.symbol for etf in coherent(examined, by_etf, best=matches[0].similarity)}
            held = {
                instrument_id: kept
                for instrument_id, holders in offered.items()
                if (kept := [h for h in holders if h.etf in chosen])
            }
            present = {m.instrument_id for m in candidates}
            candidates += [p for i, p in profiles.items() if i in held and i not in present]
            meanings = split_meanings(candidates)
        else:
            meanings = [matches]
        interpretations = [
            _interpretation(topic, meaning, limit=limit, semantic=is_semantic, held=held)
            for meaning in meanings
        ]

    return TopicResolution(
        topic=topic,
        judgement=judgement,
        interpretations=interpretations,
        embedding_model=embedder.model,
        vector_is_semantic=is_semantic,
    )
