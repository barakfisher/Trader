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

import { formatShare } from '../i18n/format.ts';
import { t } from '../i18n/index.ts';

export interface SeverityBand {
  /** The rule, in the words the feed uses for it. */
  rule: string;
  /** What the number measures, so a bare "3%" is not left to interpretation. */
  measure: string;
  info: string;
  notable: string;
  high: string;
}

/**
 * The words are the catalogue's (`kinds`, `severity.measures`) and are read when
 * a band is read, so a change of language reaches a page that is already open.
 */
function band(
  kind: 'price_move' | 'sigma_move' | 'drawdown' | 'allocation_drift',
  levels: [number, number, number],
  unit: (value: number) => string,
): SeverityBand {
  return {
    get rule() {
      return t(`kinds.${kind}`);
    },
    get measure() {
      return t(`severity.measures.${kind}`);
    },
    get info() {
      return unit(levels[0]);
    },
    get notable() {
      return unit(levels[1]);
    },
    get high() {
      return unit(levels[2]);
    },
  };
}

const percent = (value: number) => formatShare(value, 0);
const sigma = (value: number) => t('units.sigma', { value });
const points = (value: number) => t('units.percentagePoints', { value });

export const SEVERITY_BANDS: readonly SeverityBand[] = [
  band('price_move', [3, 5, 8], percent),
  band('sigma_move', [2, 3, 4], sigma),
  band('drawdown', [10, 15, 25], percent),
  band('allocation_drift', [5, 10, 15], points),
];

/**
 * What choosing a level as a floor actually admits. Phrased as the consequence
 * rather than the definition: the question a user is answering here is "how
 * often do I want to hear from this?", not "what does notable mean?".
 */
export function describeSeverityFloor(severity: ObservationSeverity): string {
  return t(`severity.floors.${severity}`);
}

/** The ladder in the order the engine ranks it, lowest floor first. */
export const SEVERITY_CHOICES: readonly { value: ObservationSeverity; label: string }[] = (
  ['info', 'notable', 'high'] as const
).map((value) => ({
  value,
  get label() {
    return t(`severity.choices.${value}`);
  },
}));
