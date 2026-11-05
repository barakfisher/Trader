import { Link } from '@tanstack/react-router';

import type { RatingWord, ResearchHolding } from '@traders/shared';

import { formatDate } from '../i18n/format.ts';
import { useTranslation } from '../i18n/index.ts';
import { getDisplayTimeZone } from '../lib/relativeTime.ts';
import { useResearchQuery } from '../queries/research.ts';

const GAIN = 'border-gain/40 bg-gain/10 text-gain';
const LOSS = 'border-loss/40 bg-loss/10 text-loss';
const FLAT = 'border-border-subtle bg-surface-hover text-text-muted';
/** Trim is a lighter red than Sell: reduce, not exit. */
const LOSS_LIGHT = 'border-loss/40 bg-transparent text-loss';

/**
 * A research rating's word on its colour (D254, D390): green to add or buy, red
 * to sell or avoid, outlined red to trim, gray to hold or wait - never the
 * colour alone (guardrail 4), and gray rather than yellow, which already means
 * a warning here. The words stored before D390 keep their colours.
 */
const TONE: Record<RatingWord, string> = {
  buy_more: GAIN,
  hold: FLAT,
  trim: LOSS_LIGHT,
  sell: LOSS,
  buy: GAIN,
  wait: FLAT,
  avoid: LOSS,
  bullish: GAIN,
  bearish: LOSS,
  neutral: FLAT,
};

export function SentimentBadge({ rating }: { rating: RatingWord }) {
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
 *
 * `inline` is a phone card's form: the same word, agent, date and stale mark on
 * one line beside the symbol, and nothing at all for a holding with no rating -
 * a dash in a card has no column to explain it.
 */
export function SentimentCell({
  holding,
  inline = false,
}: {
  holding: ResearchHolding | undefined;
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const latest = holding?.latest;
  if (!latest) return inline ? null : <span className="text-text-muted">—</span>;
  return (
    <Link
      to="/research"
      hash={holding.symbol}
      className={`tap-compact inline-flex hover:opacity-80 ${inline ? 'tap-tight [--tap-shift:-0.375rem] flex-wrap items-center gap-1' : 'flex-col items-start gap-0.5'}`}
      aria-label={t('research.cellLabel', {
        rating: t(`research.ratings.${latest.rating}`),
        agent: latest.agentName,
        date: ratedOn(latest.ratedAt),
      })}
    >
      <SentimentBadge rating={latest.rating} />
      <span className="text-2xs text-text-muted">
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
export function useSentiments(): { shown: boolean; byInstrument: Map<string, ResearchHolding> } {
  const research = useResearchQuery().data;
  return {
    shown: research?.agent != null,
    byInstrument: new Map((research?.holdings ?? []).map((holding) => [holding.instrumentId, holding])),
  };
}
