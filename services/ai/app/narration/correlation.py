"""Pair a price finding with the news published around it.

The product's central question is "why did it move?", and this module produces
candidates for an answer without ever asserting one. Correlation is not
causation, and nothing here pretends otherwise: an article published near a move
and mentioning the instrument is *context a reader can evaluate*, which is a
weaker and more honest claim than "this is why".

Two rules, both deliberately conservative:

  * **Time.** Only articles published within a window around the finding's
    observation time. A story from last month explains nothing about today, and
    one published after the move it supposedly caused explains less than nothing.
    A small forward allowance exists because publication timestamps are
    unreliable and a story often lands minutes after the move it reports.
  * **Subject.** Only articles the entity extractor linked to this instrument,
    and the extractor already refuses to link a bare ticker without corroboration.
    A wrong link here becomes a wrong explanation, which is worse than no
    explanation at all.

Ordering is by salience then recency, so the narration prompt sees the most
relevant story first and a token limit truncates the least useful.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from app.analysis.findings import Finding

#: How far back a story may have been published and still be offered as context.
DEFAULT_LOOKBACK = timedelta(days=3)

#: How far forward. Publication timestamps lag the event they describe, and a
#: report of this morning's drop is frequently stamped this afternoon.
DEFAULT_LOOKAHEAD = timedelta(hours=12)


@dataclass(frozen=True, slots=True)
class CandidateArticle:
    """An article the entity extractor linked to an instrument."""

    article_id: str
    symbol: str
    title: str
    url: str
    source: str
    published_at: datetime
    salience: float = 0.0
    sentiment: float | None = None


def subject_symbol(finding: Finding) -> str:
    return finding.subject_ref.rsplit(":", 1)[-1]


def correlate(
    finding: Finding,
    articles: list[CandidateArticle],
    *,
    lookback: timedelta = DEFAULT_LOOKBACK,
    lookahead: timedelta = DEFAULT_LOOKAHEAD,
    limit: int = 3,
) -> list[CandidateArticle]:
    """Articles that could plausibly bear on `finding`, most relevant first.

    Pure: the arguments are the whole world this function sees.
    """
    symbol = subject_symbol(finding)
    earliest = finding.as_of - lookback
    latest = finding.as_of + lookahead

    relevant = [
        article
        for article in articles
        if article.symbol == symbol and earliest <= article.published_at <= latest
    ]
    relevant.sort(key=lambda article: (article.salience, article.published_at), reverse=True)
    return relevant[:limit]


def as_evidence(articles: list[CandidateArticle]) -> list[dict[str, object]]:
    """The articles as they are stored on the observation.

    Included in the evidence rather than referenced from it, because an
    explanation that cites a headline has to keep that headline: the reader must
    be able to see what the claim rested on, even after the article is gone.
    """
    return [
        {
            "article_id": article.article_id,
            "title": article.title,
            "url": article.url,
            "source": article.source,
            "published_at": article.published_at.isoformat(),
            "salience": article.salience,
        }
        for article in articles
    ]
