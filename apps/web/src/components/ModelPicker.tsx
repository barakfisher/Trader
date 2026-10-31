import { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, TriangleAlert } from 'lucide-react';

import type { ListedModelView, ModelChoicesResponse, ModelResolutionView } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { leftToRight } from '../i18n/format.ts';
import { useTranslation } from '../i18n/index.ts';
import { formatMicroUsd, formatPerMtok } from '../lib/llmCalls.ts';
import { Button, ErrorNote } from './ui.tsx';

/** At most this many matches are offered at once; the search narrows the rest. */
export const MAX_SHOWN_MODELS = 60;

interface Saving {
  mutate: (model: string | null) => void;
  isPending: boolean;
  error: Error | null;
}

/** The tested models first, then by name: the scans were tuned on the first (D285). */
function ordered(models: ListedModelView[]): ListedModelView[] {
  return [...models].sort(
    (a, b) => Number(b.tested) - Number(a.tested) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

export function matching(models: ListedModelView[], search: string): ListedModelView[] {
  const needle = search.trim().toLowerCase();
  if (needle === '') return models;
  return models.filter((model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle));
}

/**
 * One model choice from OpenRouter's list (D244, D283): a search over the list,
 * a native select of what matches (it works the same with a finger), and for the
 * selection its price, its cost per scan where it would scan, and whether the
 * scans were tuned on it (D285). Nothing is saved until *Save*.
 *
 * A saved model the list no longer has is said first, with the model used
 * meanwhile (D284), and stays selectable as it is so the select tells the truth.
 * "Not chosen" runs on the tested model, or for the admin's agent on the Admin
 * page's agent model (D353): `unchosen` says which.
 */
export function ModelPicker({
  id,
  label,
  data,
  resolution,
  save,
  perScan,
  unchosen,
}: {
  id: string;
  label: string;
  data: ModelChoicesResponse;
  resolution: ModelResolutionView;
  save: Saving;
  /** Show each model's cost per scan: for an agent. */
  perScan: boolean;
  /** What "not chosen" runs on, and how the option says it; the tested model when absent. */
  unchosen?: { model: string; label: string };
}) {
  const { t } = useTranslation();
  const stored = resolution.saved ?? '';
  const [selected, setSelected] = useState(stored);
  const [search, setSearch] = useState('');
  useEffect(() => setSelected(stored), [stored]);

  const models = useMemo(() => ordered(data.models), [data.models]);
  const byId = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  const found = matching(models, search);
  const shown = found.slice(0, MAX_SHOWN_MODELS);
  // The selection is always an option, even when the search hides it.
  const selectedModel = byId.get(selected);
  if (selectedModel && !shown.includes(selectedModel)) shown.unshift(selectedModel);
  const unchosenModel = byId.get(unchosen?.model ?? data.fallbackModel);
  const nameOf = (modelId: string | null) => leftToRight((modelId && byId.get(modelId)?.name) || modelId || '');
  const detail = selected === '' ? unchosenModel : selectedModel;

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {resolution.fallback ? (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{t('models.fallback', { saved: leftToRight(resolution.saved ?? ''), effective: nameOf(resolution.effective) })}</span>
        </p>
      ) : (
        <p className="text-xs text-text-muted">{t('models.inUse', { model: nameOf(resolution.effective) })}</p>
      )}
      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t('models.search')}
        aria-label={t('models.searchLabel', { label })}
        className="input sm:max-w-md"
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={id}
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className="input min-w-0 sm:max-w-md"
        >
          <option value="">{unchosen?.label ?? t('models.notChosen')}</option>
          {resolution.fallback && resolution.saved && (
            <option value={resolution.saved} disabled>
              {t('models.noLongerOffered', { model: leftToRight(resolution.saved) })}
            </option>
          )}
          {shown.map((model) => (
            <option key={model.id} value={model.id}>
              {model.tested ? t('models.optionTested', { name: model.name }) : model.name}
            </option>
          ))}
        </select>
        <Button onClick={() => save.mutate(selected === '' ? null : selected)} disabled={save.isPending || selected === stored}>
          {save.isPending ? t('models.saving') : t('models.save')}
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        {found.length > MAX_SHOWN_MODELS
          ? t('models.showing', { shown: MAX_SHOWN_MODELS, count: found.length })
          : t('models.matches', { count: found.length })}
      </p>
      {detail && (
        <div className="space-y-1 text-xs">
          <p dir="ltr" className="font-mono text-text-muted">
            {detail.id}
          </p>
          <p>
            {t('models.price', {
              input: formatPerMtok(detail.promptUsdPerMtok),
              output: formatPerMtok(detail.completionUsdPerMtok),
            })}
          </p>
          {perScan && <p>{t('models.perScan', { cost: formatMicroUsd(detail.scanEstimateMicroUsd) })}</p>}
          {detail.tested ? (
            <p className="flex items-center gap-1 text-gain">
              <BadgeCheck className="size-4" aria-hidden />
              {t('models.tested')}
            </p>
          ) : (
            <p className="text-warn">{t('models.untested', { model: nameOf(data.fallbackModel) })}</p>
          )}
        </div>
      )}
      {!data.live && <p className="text-xs text-text-muted">{t('models.notLive')}</p>}
      {save.error && <ErrorNote message={errorMessage(save.error, t('models.saveFailed'))} />}
    </div>
  );
}
