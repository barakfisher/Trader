import { Sparkles } from 'lucide-react';

import { useTranslation } from '../i18n/index.ts';
import { describeNarration, isNoteworthy, narrationOptions } from '../lib/narrationStatus.ts';
import { useNarrationQuery } from '../queries/narration.ts';

/**
 * A header badge saying who wrote the explanations in the feed, and what it
 * would take to change that.
 *
 * It renders nothing in the one state that needs no comment - a model
 * narrating normally - because a badge that is always there is a badge nobody
 * reads. Everything it does show is a cost the reader is paying in quality.
 *
 * It names no model and no "free tier": both were read from the installation's
 * `LLM_MODEL`, which is not the model a user's explanations run on (D244).
 *
 * The detail is a hover rather than a dialog: this is context for a reader
 * already looking at something else, and it must never be in the way of the
 * portfolio.
 */
export function NarrationBadge() {
  const health = useNarrationQuery().data;
  const { t } = useTranslation();

  if (health === undefined || !isNoteworthy(health)) return null;

  const copy = describeNarration(health.state);
  const options = narrationOptions();
  const tone = {
    neutral: 'border-border-subtle text-text-muted',
    warn: 'border-warn/40 text-warn',
    loss: 'border-loss/40 text-loss',
  }[copy.tone];

  return (
    <div className="group relative">
      <button
        type="button"
        className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${tone}`}
        aria-label={t('narration.badgeLabel', { label: copy.label })}
      >
        <Sparkles className="size-3" aria-hidden />
        <span>{copy.label}</span>
      </button>

      {/* Shown on hover and on keyboard focus: a control reachable only by mouse
          hides its explanation from anyone not using one. */}
      <div className="pointer-events-none absolute end-0 z-20 mt-2 hidden w-80 rounded-xl border border-border-subtle bg-surface-raised p-3 text-start shadow-lg group-hover:block group-focus-within:block">
        <p className="text-xs text-text-primary">{copy.summary}</p>
        {copy.consequence && <p className="mt-1.5 text-xs text-text-muted">{copy.consequence}</p>}

        {/* The way out of `own_key` is the user's own key (D245), said in the summary;
            funding the installation's model is not theirs to do. */}
        {health.state !== 'own_key' && (
          <div className="mt-3 space-y-2 border-t border-border-subtle pt-2">
            {options.map((option) => (
              <div key={option.title}>
                <p className="text-xs font-medium text-text-primary">{option.title}</p>
                <p className="text-xs text-text-muted">{option.detail}</p>
              </div>
            ))}
          </div>
        )}

        {health.sampleSize > 0 && (
          <p className="mt-2 border-t border-border-subtle pt-2 text-2xs text-text-muted">
            {t('narration.sample', { count: health.sampleSize })}
            {health.lastFallbackReason &&
              t('narration.fallback', { reason: health.lastFallbackReason })}
          </p>
        )}
      </div>
    </div>
  );
}
