import type { ReactNode } from 'react';

import { useTranslation } from '../i18n/index.ts';
import { directionOf } from '../lib/textDirection.ts';

/**
 * The one tooltip every chart draws: a raised card with a heading and lines
 * beneath it, in the theme's tokens. recharts' default tooltip takes inline
 * colours instead, and on the allocation donut that came out as black text on
 * a blue the same as a slice - so no chart uses it; each passes its lines here
 * through `<Tooltip content>`.
 *
 * The chart's box is pinned left to right (`CHART_DIRECTION`); the tooltip is
 * text, so it reads in the language's direction - in Hebrew a pinned tooltip
 * printed "(100.0%) $ 3,366.70", the share before the value.
 */
export function ChartTooltip({ title, children }: { title: ReactNode; children: ReactNode }) {
  const { i18n } = useTranslation();
  return (
    <div
      dir={directionOf(i18n.language)}
      className="rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-xs shadow-lg"
    >
      <p className="mb-1 font-medium text-text-primary">{title}</p>
      {children}
    </div>
  );
}
