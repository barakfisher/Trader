import { Link } from '@tanstack/react-router';

import type { ResearchHolding, SentimentRating } from '@traders/shared';

import { formatDate } from '../i18n/format.ts';
import { useTranslation } from '../i18n/index.ts';
import { getDisplayTimeZone } from '../lib/relativeTime.ts';
import { useResearchQuery } from '../queries/research.ts';

/**
 * A research rating's word on its colour (D254): green Bullish, red Bearish,
 * gray Neutral - never the colour alone (guardrail 4), and gray rather than
 * yellow, which already means a warning here.
 */
const TONE: Record<SentimentRating, string> = {
  bullish: 'border-gain/40 bg-gain/10 text-gain',
  bearish: 'border-loss/40 bg-loss/10 text-loss',
  neutral: 'border-border-subtle bg-surface-hover text-text-muted',
};

export function SentimentBadge({ rating }: { rating: SentimentRating }) {
  const { t } = useTranslation();
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${TONE[rating]}`}>
      {t(`research.ratings.${rating}`)}
    </span>
  );
}

/**
 * "Analyst, 24 Oct" with each part isolated (FSI..PDI): a Latin agent name beside
 * a Hebrew date otherwise reorders on a right-to-left page.
 */
export function byOn(agent: string, at: string): { agent: string; date: string } {
  return { agent: `\u2068${agent}\u2069`, date: `\u2068${ratedOn(at)}\u2069` };
}

/** A rating's day, in the user's own zone (D163). */
export function ratedOn(at: string): string {
  return formatDate(new Date(at), { day: 'numeric', month: 'short', timeZone: getDisplayTimeZone() });
}

/**
 * One holding's latest rating, as the Dashboard's *Sentiment* cell shows it: the
 * word, the agent and the date, and a stale mark past the set age (guardrail
 * 3). It links to the research page, where the rationale and the disclaimer are.
 */
export function SentimentCell({ holding }: { holding: ResearchHolding | undefined }) {
  const { t } = useTranslation();
  const latest = holding?.latest;
  if (!latest) return <span className="text-text-muted">—</span>;
  return (
    <Link
      to="/research"
      hash={holding.symbol}
      className="inline-flex flex-col items-start gap-0.5 hover:opacity-80"
      aria-label={t('research.cellLabel', {
        rating: t(`research.ratings.${latest.rating}`),
        agent: latest.agentName,
        date: ratedOn(latest.ratedAt),
      })}
    >
      <SentimentBadge rating={latest.rating} />
      <span className="text-[11px] text-text-muted">
        {t('research.byOn', byOn(latest.agentName, latest.ratedAt))}
        {latest.stale && <span className="ms-1 text-warn">{t('research.stale')}</span>}
      </span>
    </Link>
  );
}

/**
 * The latest ratings by instrument, for the holdings tables; `shown` is whether
 * the column belongs on them at all - only once an agent researches the
 * portfolio, so a user who never assigned one sees no empty column.
 */
export function useSentiments(): {
  shown: boolean;
  byInstrument: Map<string, ResearchHolding>;
  /** An instrument's latest rating, for sorting by it; null before its first. */
  ratingOf: (instrumentId: string) => SentimentRating | null;
} {
  const research = useResearchQuery().data;
  const byInstrument = new Map((research?.holdings ?? []).map((holding) => [holding.instrumentId, holding]));
  return {
    shown: research?.agent != null,
    byInstrument,
    ratingOf: (instrumentId) => byInstrument.get(instrumentId)?.latest?.rating ?? null,
  };
}
