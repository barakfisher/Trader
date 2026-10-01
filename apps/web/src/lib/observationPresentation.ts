/**
 * How an observation presents itself: its severity, its kind and its subject.
 *
 * Severity deliberately does not use the gain/loss colours. Those two tokens
 * mean one thing everywhere else in this dashboard - money went up, money went
 * down - and a "high" severity says neither: a drawdown and an allocation drift
 * are both high-severity and only one of them is a loss. Severity is therefore
 * rendered on the attention axis instead (muted, warn, loss), which is the same
 * ladder `SummaryCards` and `HoldingsTable` already use for a degraded total
 * and a stale quote.
 */

import type { ObservationSeverity } from '@traders/shared';

import { i18n, t } from '../i18n/index.ts';

/** Ascending, matching the engine's own ladder in `analysis/findings.py`. */
export const SEVERITY_ORDER: readonly ObservationSeverity[] = ['info', 'notable', 'high'];

export interface SeverityStyle {
  label: string;
  /** Tailwind classes for the severity chip. */
  chipClassName: string;
  /** The rail down the left of the card, so severity survives a glance. */
  railClassName: string;
}

const SEVERITY_CLASSES: Record<ObservationSeverity, Omit<SeverityStyle, 'label'>> = {
  info: {
    chipClassName: 'bg-surface-hover text-text-muted',
    railClassName: 'bg-border-subtle',
  },
  notable: {
    chipClassName: 'bg-warn/15 text-warn',
    railClassName: 'bg-warn',
  },
  high: {
    chipClassName: 'bg-loss/15 text-loss',
    railClassName: 'bg-loss',
  },
};

export function severityStyle(severity: string): SeverityStyle {
  const known: ObservationSeverity = severity in SEVERITY_CLASSES ? (severity as ObservationSeverity) : 'info';
  return { label: t(`severity.labels.${known}`), ...SEVERITY_CLASSES[known] };
}

export function severityRank(severity: string): number {
  const index = SEVERITY_ORDER.indexOf(severity as ObservationSeverity);
  // An unknown severity from a newer engine sorts below the ones we know rather
  // than above them: we cannot claim it is urgent when we cannot read it.
  return index === -1 ? -1 : index;
}

/** A kind this build has never seen still gets a readable name, never a blank. */
export function kindLabel(kind: string): string {
  return i18n.exists(`kinds.${kind}`)
    ? t(`kinds.${kind as 'price_move'}`)
    : humanise(kind.replace(/_/g, ' '));
}

/**
 * The thing the observation is about, from its kind-prefixed handle:
 * `instrument:NVDA` -> `NVDA`, `portfolio:allocation:AAPL` -> `AAPL`.
 *
 * A topic's handle carries its id, which survives a rename and means nothing to
 * a reader, so a topic is named by the label its evidence recorded.
 */
export function subjectLabel(subjectRef: string, evidence?: unknown): string {
  if (subjectRef.startsWith('topic:') && evidence && typeof evidence === 'object') {
    const label = (evidence as { topic_label?: unknown }).topic_label;
    if (typeof label === 'string' && label.length > 0) return label;
  }
  const segments = subjectRef.split(':').filter((segment) => segment.length > 0);
  return segments.at(-1) ?? subjectRef;
}

/** `daily-return` -> `Daily return`. Concept slugs are corpus ids, not copy. */
export function conceptLabel(slug: string): string {
  return humanise(slug.replace(/[-_]/g, ' '));
}

function humanise(words: string): string {
  const trimmed = words.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
