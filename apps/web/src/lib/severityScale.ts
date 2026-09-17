/**
 * What the severity ladder costs the reader, in the numbers that produce it.
 *
 * A settings page that offers "info / notable / high" and stops there asks the
 * user to pick a volume with no units. These are the bands the engine actually
 * applies - `services/ai/app/analysis/thresholds.py` - restated as copy so the
 * choice can be made rather than guessed at.
 *
 * Restated, not imported: they live in the AI service's configuration, they are
 * an operator's to retune, and no endpoint publishes them today. So the page
 * says out loud that these are the defaults rather than presenting them as
 * fixed facts, and this file is the one place to correct if an operator moves
 * them. The alternative - an endpoint that serves the thresholds - is the right
 * answer the day a second installation tunes them, and is not worth its wire
 * contract before that.
 */

import type { ObservationSeverity } from '@traders/shared';

export interface SeverityBand {
  /** The rule, in the words the feed uses for it. */
  rule: string;
  /** What the number measures, so a bare "3%" is not left to interpretation. */
  measure: string;
  info: string;
  notable: string;
  high: string;
}

export const SEVERITY_BANDS: readonly SeverityBand[] = [
  {
    rule: 'Price move',
    measure: 'one day, in either direction',
    info: '3%',
    notable: '5%',
    high: '8%',
  },
  {
    rule: 'Unusual move',
    measure: 'against the holding’s own recent volatility',
    info: '2σ',
    notable: '3σ',
    high: '4σ',
  },
  {
    rule: 'Drawdown',
    measure: 'below a 30-day high',
    info: '10%',
    notable: '15%',
    high: '25%',
  },
  {
    rule: 'Allocation drift',
    measure: 'away from your target weight',
    info: '5pp',
    notable: '10pp',
    high: '15pp',
  },
];

/**
 * What choosing a level as a floor actually admits. Phrased as the consequence
 * rather than the definition: the question a user is answering here is "how
 * often do I want to hear from this?", not "what does notable mean?".
 */
const FLOOR_DESCRIPTIONS: Record<ObservationSeverity, string> = {
  info: 'Everything the engine finds, including the smallest moves it reports.',
  notable: 'Middle-of-the-ladder findings and above. Ordinary days stay quiet.',
  high: 'Only the largest moves on the ladder. The fewest interruptions.',
};

export function describeSeverityFloor(severity: ObservationSeverity): string {
  return FLOOR_DESCRIPTIONS[severity];
}

/** The ladder in the order the engine ranks it, lowest floor first. */
export const SEVERITY_CHOICES: readonly { value: ObservationSeverity; label: string }[] = [
  { value: 'info', label: 'Info and above' },
  { value: 'notable', label: 'Notable and above' },
  { value: 'high', label: 'High only' },
];
