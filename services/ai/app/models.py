"""Wire models shared with the orchestrator.

These pydantic models are the source of truth for the OpenAPI schema, which is
what `packages/shared` generates its TypeScript client from. Keep field names
stable: renaming one is a breaking API change.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

AssetClass = Literal["equity", "etf", "crypto", "fx", "index", "unknown"]


class Quote(BaseModel):
    """A single price observation. `price_minor` is integer minor units."""

    symbol: str
    price_minor: int
    currency: str
    as_of: datetime = Field(
        description=(
            "When this price was observed, not when it was fetched. Providers that "
            "publish a trade timestamp supply it directly; for the rest it is the "
            "fetch time floored to the provider's freshness window, so repeated "
            "reads of one observation share an as_of and deduplicate on storage."
        )
    )
    source: str = Field(
        description="Provider that produced this quote, e.g. 'fixture', 'yfinance'."
    )
    delay_seconds: int = Field(
        default=0,
        description="Provider-declared quote delay. Displayed in the UI; 0 means real time.",
    )
    previous_close_minor: int | None = None
    day_change_pct: float | None = None
    stale: bool = Field(
        default=False,
        description="True when served from cache after every live provider failed.",
    )


class DailyClose(BaseModel):
    """One day's closing price.

    `as_of` is dated to the session close rather than to midnight, so a daily
    close and an intraday quote for the same instrument order sensibly in one
    series. Money is integer minor units, as everywhere.
    """

    symbol: str
    as_of: datetime
    price_minor: int
    currency: str
    source: str


class BackfillInstrument(BaseModel):
    instrument_id: str
    symbol: str


class BackfillRequest(BaseModel):
    """Which instruments to fetch daily closes for, and how far back."""

    instruments: list[BackfillInstrument] = Field(min_length=1, max_length=500)
    days: int = Field(default=180, ge=2, le=3650)


class BackfillResponse(BaseModel):
    written: int = Field(0, description="Closes inserted, or corrected from an earlier run.")
    already_present: int = 0
    per_symbol: dict[str, int] = Field(default_factory=dict)
    without_history: list[str] = Field(
        default_factory=list,
        description=(
            "Symbols no provider could supply a series for. Reported rather than "
            "omitted: a holding the engine cannot analyse is something the user "
            "should be able to discover."
        ),
    )
    not_final: int = Field(
        0,
        description=(
            "Candles not stored because their session had not ended: a provider "
            "returns the day still trading, dated to its close."
        ),
    )


class DailyClosePoint(BaseModel):
    """One day of an instrument's stored series, as the analysis rules read it."""

    day: date = Field(description="The UTC calendar day this close belongs to.")
    price_minor: int
    currency: str
    as_of: datetime = Field(description="When the price that closed the day was observed.")


class PriceHistoryResponse(BaseModel):
    """An instrument's daily closes, oldest first: real stored prices only.

    The same series `run_portfolio_scan` analyses - `load_price_series` with this
    installation's excluded sources, collapsed by `normalise` - so a chart drawn
    from it shows the prices a finding was computed from. A day with no stored
    price is absent, never filled.
    """

    instrument_id: str
    days: int
    closes: list[DailyClosePoint]


class QuoteMarket(BaseModel):
    """Where an instrument trades, as the caller's instruments table records it."""

    asset_class: AssetClass = "unknown"
    exchange: str | None = Field(
        default=None, description="Exchange name or code, e.g. 'XETRA', 'NASDAQ', 'NMS'."
    )


class QuoteRequest(BaseModel):
    symbols: list[str] = Field(min_length=1, max_length=200)
    markets: dict[str, QuoteMarket] = Field(
        default_factory=dict,
        description=(
            "Optional, by symbol: the instrument's asset class and exchange. They decide "
            "how long a quote is cached - crypto never closes, and an exchange's session "
            "is judged in its own timezone. A symbol without an entry is judged by its "
            "shape and by US market hours."
        ),
    )


class QuoteResponse(BaseModel):
    quotes: list[Quote]
    missing: list[str] = Field(
        default_factory=list,
        description="Symbols no provider in the chain could price.",
    )


class Instrument(BaseModel):
    symbol: str = Field(description="Canonical provider symbol, e.g. 'AAPL', 'BTC-USD'.")
    name: str | None = None
    asset_class: AssetClass = "unknown"
    exchange: str | None = None
    currency: str = "USD"
    source: str = "unknown"


class InstrumentResolution(BaseModel):
    """Result of resolving a user-supplied string to a tradable instrument.

    `candidates` is non-empty and ordered by confidence whenever `resolved` is
    None, so the UI can ask the user to disambiguate instead of guessing.
    """

    query: str
    resolved: Instrument | None = None
    candidates: list[Instrument] = Field(default_factory=list)
    confidence: float = 0.0
    reason: str | None = None


class FxRate(BaseModel):
    base: str
    quote: str
    rate: str = Field(description="Decimal as string to avoid float drift in transport.")
    as_of: datetime
    source: str


# --- Analysis (Milestone 2) ---------------------------------------------------

Severity = Literal["info", "notable", "high"]
NarrationSource = Literal["llm", "template"]


class ScanHolding(BaseModel):
    """One holding as the scan needs it.

    `value_minor` is the holding's market value in the portfolio's base currency,
    computed by the orchestrator, which owns valuation and the FX rates. It is
    null when the holding could not be priced - carried rather than omitted so
    the scan can report that allocation drift was skipped, and why.
    """

    instrument_id: str
    symbol: str
    value_minor: int | None = None
    currency: str = "USD"
    as_of: datetime | None = Field(
        default=None,
        description=(
            "When the price behind value_minor was observed. Allocation drift dates a "
            "weight by the stalest price contributing to it, so a position without this "
            "cannot take part."
        ),
    )


class PortfolioScanRequest(BaseModel):
    base_currency: str = "USD"
    holdings: list[ScanHolding] = Field(min_length=1, max_length=500)
    target_weights: dict[str, str] = Field(
        default_factory=dict,
        description="symbol -> target weight as a decimal string, e.g. {'VOO': '0.25'}.",
    )
    known_dedupe_keys: list[str] = Field(
        default_factory=list,
        max_length=5000,
        description=(
            "Dedupe keys the caller has already stored. Matching findings are counted "
            "and skipped before narration, so a repeat costs a hash rather than a model "
            "call. Omit to narrate everything."
        ),
    )


class ObservationOut(BaseModel):
    """A finding, its words, and its identity.

    `evidence` carries every figure the headline and explanation rest on; the
    narration validator rejects any that is not here. `narration_source` says who
    wrote the words, and `fallback_reason` why the model did not, so the
    rejection rate is measurable.
    """

    kind: str
    severity: Severity
    subject_ref: str
    as_of: datetime
    headline: str
    explanation: str
    evidence: dict[str, Any] = Field(default_factory=dict)
    concept_refs: list[str] = Field(default_factory=list)
    dedupe_key: str
    narration_source: NarrationSource
    fallback_reason: str = "none"


class ScanStatsOut(BaseModel):
    subjects: int = 0
    subjects_with_history: int = 0
    findings: int = 0
    already_known: int = 0
    narrated_by_llm: int = 0
    narration_fallbacks: dict[str, int] = Field(default_factory=dict)
    drift_skipped_reason: str | None = None
    insufficient_history: list[str] = Field(default_factory=list)


class PortfolioScanResponse(BaseModel):
    observations: list[ObservationOut]
    stats: ScanStatsOut


class NewsInstrument(BaseModel):
    """An instrument the matcher may link articles to. The name is what prose uses."""

    instrument_id: str
    symbol: str
    name: str | None = None
    asset_class: str = "unknown"


class NewsCollectRequest(BaseModel):
    instruments: list[NewsInstrument] = Field(min_length=1, max_length=500)
    lookback_hours: int = Field(default=48, ge=1, le=24 * 60)
    #: How long unlinked market-feed articles are kept (decision 60). The
    #: orchestrator sends discovery's window plus a proposal's lifetime; absent,
    #: nothing is pruned.
    market_retention_days: int | None = Field(default=None, ge=1, le=365)


class SuspectedNetwork(BaseModel):
    """An outlet in the market feed whose headlines look generated, for a person to judge."""

    source: str
    headlines: int
    #: How many of them carry a ticker in parentheses.
    templated: int


class NewsCollectResponse(BaseModel):
    """What one collection pass did. Every counter is here so a quiet run can be told
    apart from a broken one after the fact."""

    fetched: int = 0
    stored: int = 0
    inserted: int = 0
    duplicate_urls: int = 0
    duplicate_content: int = 0
    empty_bodies: int = 0
    entity_links: int = 0
    instruments: int = 0
    since: datetime
    providers_used: list[str] = Field(default_factory=list)
    provider_failures: list[str] = Field(default_factory=list)
    linked_symbols: dict[str, int] = Field(default_factory=dict)
    #: Stored articles the market feed kept (linked or not).
    market_articles: int = 0
    #: Unlinked market-feed articles deleted as older than the retention.
    pruned: int = 0
    #: Outlets not yet excluded that look like a ticker network. Empty is the
    #: expected answer; a name here is a candidate for `TICKER_NETWORKS`.
    suspected_networks: list[SuspectedNetwork] = Field(default_factory=list)


class TopicScanInstrument(BaseModel):
    instrument_id: str
    symbol: str


class TopicScanTopic(BaseModel):
    """One active topic and the instruments the user confirmed for it."""

    topic_id: str
    label: str
    instruments: list[TopicScanInstrument] = Field(min_length=1, max_length=100)


class TopicScanRequest(BaseModel):
    topics: list[TopicScanTopic] = Field(min_length=1, max_length=50)
    known_dedupe_keys: list[str] = Field(
        default_factory=list,
        max_length=5000,
        description="As on PortfolioScanRequest: matching findings are counted, not narrated.",
    )


class TopicScanStatsOut(BaseModel):
    topics: int = 0
    topics_measured: int = 0
    instruments: int = 0
    findings: int = 0
    already_known: int = 0
    narrated_by_llm: int = 0
    narration_fallbacks: dict[str, int] = Field(default_factory=dict)
    skipped: dict[str, str] = Field(
        default_factory=dict,
        description="Topic label -> why it could not be measured. A quiet topic is not listed.",
    )


class TopicScanResponse(BaseModel):
    observations: list[ObservationOut]
    stats: TopicScanStatsOut


class NarrationConfigResponse(BaseModel):
    """How narration is configured, for a UI that must not guess.

    `tier` is what a reader needs and the model id only implies: `free` is a
    route that bills nothing and is served from a shared pool, `paid` bills per
    token, `none` means no provider was asked for at all. The last is a
    configuration rather than a failure, and the three are kept distinct so a UI
    cannot report "deliberately off" as "broken".
    """

    provider: str
    model: str | None
    tier: Literal["free", "paid", "none"]
    #: Decimal as a string: money never crosses a wire as a float (guideline 3).
    daily_budget_usd: str


class ConceptSection(BaseModel):
    """One `##` section of a concept document, as chunked at ingestion.

    `ord` is the position the ingester stored, so a citation can name a section
    rather than a byte range, and `id` is the chunk's own id - stable across
    re-ingestion of an unchanged document, which is what lets it be cited at all.
    """

    id: str
    ord: int
    heading: str | None
    text: str


class ConceptDocumentResponse(BaseModel):
    """A concept explainer, assembled from its chunks in stored order.

    Served whole rather than as a retrieval result: a chip names one concept
    exactly, so there is nothing to rank and no relevance floor to apply. The
    licence and source travel with it because the corpus is required to be
    licence-clean and a reader is entitled to know where an explanation came
    from.
    """

    slug: str
    title: str
    source: str
    uri: str | None
    license: str
    sections: list[ConceptSection]


class ConceptSearchMatch(BaseModel):
    """One chunk a search returned, with where each half of the hybrid put it.

    `vector_rank` and `text_rank` are exposed rather than kept internal because
    they are the only way a reader can tell which half found a result. A null
    `vector_rank` on every match means the corpus is not embedded and the answer
    came from full-text alone - a real and recoverable state, and one that would
    otherwise be indistinguishable from working hybrid retrieval.

    `document_id` and `chunk_id` are what a citation will point at when `/ask`
    lands, which is why the chunk id is here rather than only the slug.
    """

    chunk_id: str
    document_id: str
    concept_slug: str | None
    title: str
    heading: str | None
    ord: int
    text: str
    score: float
    vector_rank: int | None
    text_rank: int | None


class ConceptSearchResponse(BaseModel):
    """A ranked answer, and an honest label for what produced the ranking.

    `vector_is_semantic` is False while the configured embedder ranks by word
    overlap alone, and it is on the wire rather than in a log because a caller
    cannot otherwise distinguish "retrieval understood the question" from
    "retrieval matched some words". Guideline 7 in its retrieval form: the thing
    that is not available is reported as not available.

    There is deliberately no relevance floor and no refusal here. Deciding that
    the corpus does not cover a question is `/ask`'s judgement to make in slice
    3, and making it twice - once silently at this layer and once visibly there -
    would mean a question could be refused by a threshold nobody chose.
    """

    query: str
    matches: list[ConceptSearchMatch]
    embedding_model: str
    vector_is_semantic: bool


class AskRequest(BaseModel):
    """One question, plus the portfolio context needed to answer it.

    `holdings` and `target_weights` mirror `PortfolioScanRequest` exactly rather
    than defining a second portfolio shape, so the orchestrator sends what it
    already builds. Both are optional: a concept question needs neither, and a
    portfolio question asked without them is refused with `no_holdings` - which
    is deliberately a different refusal from "the corpus does not cover that".
    """

    question: str = Field(min_length=1, max_length=1000)
    base_currency: str = "USD"
    holdings: list[ScanHolding] = Field(default_factory=list, max_length=500)
    target_weights: dict[str, str] = Field(default_factory=dict)


class AskCitation(BaseModel):
    """One passage an answer rests on, quoted rather than summarised.

    `text` is the chunk verbatim. A citation the reader cannot read is a
    footnote, not evidence, and the whole claim of this endpoint is that its
    answers are checkable.
    """

    chunk_id: str
    document_id: str
    concept_slug: str | None
    title: str
    heading: str | None
    text: str
    similarity: float | None


class AskResponse(BaseModel):
    """An answer, a refusal, and in both cases how it was decided.

    `answered` is the field to branch on. A refusal is a normal 200 with
    `answered: false` and a `refused_reason`, because it is an outcome rather
    than a fault - M3's exit criterion names refusing out-of-index questions as
    a thing the product must do well, and an HTTP error would make it
    indistinguishable from a broken corpus.

    `answer_source` is `extractive` (the passages, verbatim), `llm` (a model
    wrote a connecting paragraph over them, and it passed the evidence check),
    `computed` (arithmetic over the caller's holdings - never a model), or
    `none` for a refusal. It mirrors `ObservationOut.narration_source`, and
    `fallback_reason` says why a model did not write it.

    `relevance` and `best_similarity` are the floor's reasoning, exposed rather
    than hidden: "0.19, refused, floor 0.23" can be argued with, and "refused"
    alone cannot. `relevance: weak` means the answer is given but the match was
    close to the noise floor and the reader should be told so.
    """

    question: str
    intent: Literal["concept", "portfolio"]
    answered: bool
    text: str
    citations: list[AskCitation] = Field(default_factory=list)
    concept_refs: list[str] = Field(default_factory=list)
    evidence: dict[str, Any] = Field(default_factory=dict)
    answer_source: Literal["extractive", "llm", "computed", "none"]
    fallback_reason: str = "none"
    relevance: Literal["confident", "weak", "none"]
    best_similarity: float | None = None
    refused_reason: str | None = None
    vector_is_semantic: bool


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    service: str = "ai-service"
    version: str
    checks: dict[str, str] = Field(default_factory=dict)


class TopicResolveRequest(BaseModel):
    """A theme in the user's own words: "uranium", "robot surgery", "GLP-1"."""

    #: At least one non-space character; surrounding whitespace is ignored.
    topic: str = Field(min_length=1, max_length=200, pattern=r"\S")


class TopicHolder(BaseModel):
    """A source ETF that holds a candidate, and what fraction of the fund it is."""

    etf: str
    #: A fraction of the fund, as a decimal string (guideline 4): "0.108" is 10.8%.
    weight: str


class TopicCandidateOut(BaseModel):
    """One instrument offered for a topic, with the reason it was offered.

    `rationale` is a sentence from the instrument's own description, verbatim -
    never written by a model. `held_by` is the second, independent reason: the
    topic's source ETFs that hold it. Either can be checked by the reader.

    `confidence` is a band, not a number, because a cosine is not a
    probability; `similarity` is exposed for debugging and for the record, not
    for display as a percentage.
    """

    instrument_id: str
    symbol: str
    name: str | None
    asset_class: str
    sector: str | None
    industry: str | None
    similarity: float
    #: Market cap (equity) or net assets (ETF) in minor units; null when unknown.
    size_minor: int | None
    #: ISO currency of `size_minor`; null exactly when `size_minor` is null.
    size_currency: str | None
    confidence: Literal["confident", "weak"]
    rationale: str
    held_by: list[TopicHolder] = Field(default_factory=list)


class TopicInterpretationOut(BaseModel):
    """One meaning of the topic. `label` is the commonest Yahoo industry in it."""

    label: str | None
    candidates: list[TopicCandidateOut]


class UniverseCoverageOut(BaseModel):
    """What the resolver could see: the installation's side of the answer.

    `state` is `ready`, `partially_embedded` (resolution ran over `embedded` of
    `profiles`), `not_embedded` or `not_loaded`. The last two mean the topic
    was never looked at, which is why they carry a verdict of their own.
    """

    state: Literal["ready", "partially_embedded", "not_embedded", "not_loaded"]
    profiles: int
    embedded: int


class TopicResolveResponse(BaseModel):
    """Candidate instruments for a topic, or a named reason there are none.

    `verdict` is the field to branch on, and it has four values because there
    are four different situations:

    - `confident` / `weak` - candidates are offered; `weak` means the best
      match was near the floor and the reader should be told so.
    - `none` - the universe was searched and nothing in it is about this
      topic. `interpretations` is empty on purpose: the least-bad rows for a
      topic nothing is about are the failure the floor exists to prevent.
    - `unavailable` - the universe was **not** searched, because this
      installation has no searchable universe (`universe.state` says which
      step is missing). A 200 rather than an error for the reason `/ask`'s
      refusal is one, and a separate value from `none` so that "no universe"
      can never be shown to the user as "your topic matches nothing".

    Every threshold the verdict was judged by travels with it, as in `/ask`.
    """

    topic: str
    verdict: Literal["confident", "weak", "none", "unavailable"]
    #: The best cosine found; null when the universe was not searched.
    best_similarity: float | None
    refuse_below: float
    confident_above: float
    interpretations: list[TopicInterpretationOut] = Field(default_factory=list)
    #: More than one interpretation: the candidates split into unrelated
    #: businesses and the user should choose between them.
    ambiguous: bool
    universe: UniverseCoverageOut
    embedding_model: str
    vector_is_semantic: bool


class TopicDiscoverRequest(BaseModel):
    """Find recurring phrases in the window's headlines (FR-11).

    `instruments` are the ones the user holds or follows - the same list news
    was collected for. Their names are cut out of every headline, because
    "Apple" recurring across Apple's own news is not a theme.
    """

    instruments: list[NewsInstrument] = Field(default_factory=list, max_length=500)
    days: int = Field(default=7, ge=1, le=30)
    #: The most phrases returned, strongest first.
    limit: int = Field(default=20, ge=1, le=100)


class DiscoveredHeadline(BaseModel):
    """A stored headline, verbatim: the evidence a proposal quotes."""

    article_id: str
    title: str
    source: str
    published_at: datetime | None


class DiscoveredPhrase(BaseModel):
    """One recurring phrase and the headlines it recurred in.

    `phrase` is the spelling the headlines used most; `words` is the folded
    form that identifies it. Neither has been resolved to instruments: that,
    and whether it is proposed at all, is the orchestrator's decision.
    """

    phrase: str
    words: list[str]
    #: Distinct stories: articles that are republications of one another count once.
    story_count: int
    article_count: int
    source_count: int
    #: The instrument most of the phrase's articles are linked to, and how many
    #: of `article_count` are. The orchestrator judges from these whether the
    #: phrase is one company's news rather than a theme; this service does not.
    lead_instrument: str | None = None
    lead_instrument_articles: int = 0
    #: The country whose outlets carried most of the phrase's articles (FIPS code,
    #: "AS" = Australia), its name, and how many of `article_count` it carried.
    #: The orchestrator judges from these whether the phrase is one country's
    #: local news (decision 61); this service does not.
    lead_country: str | None = None
    lead_country_name: str | None = None
    lead_country_articles: int = 0
    #: Up to five of the headlines, in the order they were read (newest first).
    headlines: list[DiscoveredHeadline]


class TopicDiscoverResponse(BaseModel):
    """Recurring phrases, and enough counts to tell a quiet window from an empty one.

    `headlines == 0` means there was nothing to read - usually no news was
    collected (see `GET /runs?kind=news_collect`) - which is not the same
    statement as "headlines were read and nothing recurred".
    """

    since: datetime
    days: int
    headlines: int
    min_stories: int
    min_sources: int
    phrases: list[DiscoveredPhrase] = Field(default_factory=list)
