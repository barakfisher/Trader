/**
 * A topic's sentiment: what the rows add up to, and when they add up to nothing.
 *
 * Pure, so no database: the rows are shaped exactly as `listTopicSentimentRows`
 * returns them, one per (article, model), with a null model for an article no
 * scorer has read.
 */

import { describe, expect, it } from 'vitest';

import type { TopicSentimentRow } from '../src/db/queries.js';
import {
  MAX_ARTICLES_BEHIND,
  MIN_POLARISED_ARTICLES,
  summariseTopicSentiment,
} from '../src/services/topicSentiment.js';

const TOPIC = '10000000-0000-0000-0000-000000000001';

function row(
  id: string,
  score: string | null,
  magnitude: string | null,
  extra: Partial<TopicSentimentRow> = {},
): TopicSentimentRow {
  return {
    id,
    url: `https://example.com/${id}`,
    source: 'Example',
    title: `Article ${id}`,
    published_at: new Date('2026-09-26T10:00:00Z'),
    fetched_at: new Date('2026-09-26T10:05:00Z'),
    local_day: '2026-09-26',
    model: score === null ? null : 'lexicon-v1',
    score,
    magnitude,
    ...extra,
  };
}

describe('summariseTopicSentiment', () => {
  it('weights each article by how much polar language it carried', () => {
    const summary = summariseTopicSentiment(TOPIC, 7, [
      row('a', '1.0000', '0.1250'), // one positive word
      row('b', '-1.0000', '0.7500'), // six negative words
      row('c', '-0.5000', '0.2500'),
    ]);

    // (1*0.125 - 1*0.75 - 0.5*0.25) / (0.125 + 0.75 + 0.25) = -0.75 / 1.125
    expect(summary.score).toBe('-0.6667');
    expect(summary.gap).toBeNull();
    expect(summary.model).toBe('lexicon-v1');
    expect(summary.counts).toEqual({ articles: 3, unscored: 0, positive: 1, negative: 2, neutral: 0 });
  });

  it('gives a headline with no polar words no weight, rather than counting it as neutral', () => {
    const polar = [row('a', '1.0000', '0.2500'), row('b', '1.0000', '0.2500'), row('c', '1.0000', '0.2500')];
    const summary = summariseTopicSentiment(TOPIC, 7, [...polar, row('d', '0.0000', '0.0000')]);

    expect(summary.score).toBe('1.0000');
    expect(summary.counts.neutral).toBe(1);
    expect(summary.behind.map((article) => article.id)).not.toContain('d');
  });

  it('is null with a reason, never zero, when there is too little to say', () => {
    expect(summariseTopicSentiment(TOPIC, 7, [])).toMatchObject({ score: null, gap: 'no_articles' });
    expect(summariseTopicSentiment(TOPIC, 7, [row('a', null, null)])).toMatchObject({
      score: null,
      gap: 'not_scored',
      counts: { articles: 1, unscored: 1 },
    });
    const thin = Array.from({ length: MIN_POLARISED_ARTICLES - 1 }, (_, index) =>
      row(`p${index}`, '1.0000', '0.5000'),
    );
    expect(summariseTopicSentiment(TOPIC, 7, thin)).toMatchObject({
      score: null,
      gap: 'too_few_polarised',
    });
  });

  it('never averages two models together', () => {
    const summary = summariseTopicSentiment(TOPIC, 7, [
      row('a', '1.0000', '0.5000'),
      row('b', '1.0000', '0.5000'),
      row('c', '1.0000', '0.5000'),
      row('a', '-1.0000', '1.0000', { model: 'llm-v1' }),
    ]);

    expect(summary.model).toBe('lexicon-v1');
    expect(summary.otherModels).toEqual(['llm-v1']);
    expect(summary.score).toBe('1.0000');
    // Article `a` is one article, whatever number of opinions it has.
    expect(summary.counts.articles).toBe(3);
  });

  it('lists the articles behind the score, heaviest first, with their share of it', () => {
    const summary = summariseTopicSentiment(TOPIC, 7, [
      row('light', '1.0000', '0.2500'),
      row('heavy', '-1.0000', '0.7500'),
      row('mid', '1.0000', '0.5000'),
    ]);

    expect(summary.behind.map((article) => [article.id, article.weight])).toEqual([
      ['heavy', '0.5000'],
      ['mid', '0.3333'],
      ['light', '0.1667'],
    ]);
  });

  it('caps the list but not the counts', () => {
    const many = Array.from({ length: MAX_ARTICLES_BEHIND + 5 }, (_, index) =>
      row(`a${index}`, '1.0000', '0.5000'),
    );
    const summary = summariseTopicSentiment(TOPIC, 7, many);

    expect(summary.behind).toHaveLength(MAX_ARTICLES_BEHIND);
    expect(summary.counts.articles).toBe(MAX_ARTICLES_BEHIND + 5);
  });

  it('reports each day, newest first, and a day with no polar words as unmeasured', () => {
    const summary = summariseTopicSentiment(TOPIC, 7, [
      row('a', '1.0000', '0.5000', { local_day: '2026-09-25' }),
      row('b', '1.0000', '0.5000', { local_day: '2026-09-25' }),
      row('c', '-1.0000', '0.5000', { local_day: '2026-09-26' }),
      row('d', '0.0000', '0.0000', { local_day: '2026-09-27' }),
    ]);

    expect(summary.daily).toEqual([
      { day: '2026-09-27', articles: 1, score: null },
      { day: '2026-09-26', articles: 1, score: '-1.0000' },
      { day: '2026-09-25', articles: 2, score: '1.0000' },
    ]);
  });
});
