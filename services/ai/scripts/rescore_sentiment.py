"""Score every stored article with the current lexicon, beside its older opinions.

    python scripts/rescore_sentiment.py [--dry-run] [--batch N]

Run it once after `LEXICON_MODEL_NAME` changes. New articles are scored by
ingestion as they arrive; this covers the ones already stored, so the topic
sentiment page - which reports the scorer that read the most articles in its
window (`apps/orchestrator/src/services/topicSentiment.ts`) - moves to the new
lexicon at once instead of weeks later.

It adds rows and changes none: each article gains a row under the new name and
keeps the old one (`article_sentiment` is unique on (article, model)). It is safe
to run repeatedly and to interrupt: it reads only originals with no row under the
current name, and commits each batch, so a second run resumes where the first
stopped and a run with nothing left writes nothing. No network and no model: the
lexicon is offline.
"""

from __future__ import annotations

import argparse
import asyncio

from app.db import get_engine
from app.news.queries import count_unscored_articles, load_unscored_articles, store_sentiment
from app.news.sentiment import LexiconSentimentScorer


async def rescore(*, batch: int, dry_run: bool) -> int:
    scorer = LexiconSentimentScorer()
    engine = get_engine()
    with engine.connect() as connection:
        pending = count_unscored_articles(connection, model=scorer.name)
    print(f"{pending} article(s) without a {scorer.name} score")
    if dry_run or pending == 0:
        return 0

    written = 0
    while True:
        with engine.begin() as connection:
            rows = load_unscored_articles(connection, model=scorer.name, limit=batch)
            for article_id, title, body in rows:
                store_sentiment(connection, article_id, await scorer.score(title, body))
        if not rows:
            break
        written += len(rows)
        print(f"scored {written}/{pending}")
    print(f"done: {written} article(s) scored with {scorer.name}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Score stored articles with the current lexicon.")
    parser.add_argument("--dry-run", action="store_true", help="count what would be scored")
    parser.add_argument("--batch", type=int, default=1000, help="articles per transaction")
    args = parser.parse_args()
    return asyncio.run(rescore(batch=args.batch, dry_run=args.dry_run))


if __name__ == "__main__":
    raise SystemExit(main())
