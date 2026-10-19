import { useId } from 'react';

import { HORIZONS, MARKET_CAPS, THESIS_STYLES, type Horizon, type MarketCap, type ThesisStyle } from '@traders/shared';

import { useTranslation } from '../i18n/index.ts';
import { formatNumber } from '../i18n/format.ts';
import {
  applyRisk,
  editRule,
  mandateProblems,
  riskBand,
  type MandateDraft,
  type RiskBand,
  type SizedRule,
} from '../lib/agentMandate.ts';
import { useTaxonomyQuery } from '../queries/taxonomy.ts';
import { AgentField } from './AgentField.tsx';
import { TaxonomyPicker } from './TaxonomyPicker.tsx';
import { Spinner } from './ui.tsx';

const INPUT = 'w-full rounded-md border border-border-subtle bg-surface px-3 py-2';

/**
 * The mandate's fields (D165-D173), shared by the new-agent drawer and the
 * agent's own page. What shapes the prompt comes first - risk, horizon,
 * style - then what the scan's code enforces on every buy.
 */
export function MandateFields({ draft, onChange }: { draft: MandateDraft; onChange: (draft: MandateDraft) => void }) {
  const { t } = useTranslation();
  const taxonomy = useTaxonomyQuery();
  const problems = new Set(mandateProblems(draft));
  const band = riskBand(draft.riskLevel);

  const rule = (name: SizedRule, label: string, hint: string) => (
    <AgentField label={label} hint={hint}>
      <input
        value={draft[name]}
        onChange={(event) => onChange(editRule(draft, name, event.target.value))}
        inputMode="decimal"
        dir="ltr"
        placeholder={t('agents.mandate.noLimit')}
        aria-invalid={problems.has(name)}
        className={`${INPUT} text-start`}
      />
    </AgentField>
  );

  return (
    <fieldset className="space-y-3 rounded-md border border-border-subtle p-3">
      <legend className="px-1 text-sm font-medium">{t('agents.mandate.title')}</legend>

      <RiskSlider level={draft.riskLevel} band={band} onChange={(level) => onChange(applyRisk(draft, level))} />

      <div className="grid gap-3 sm:grid-cols-2">
        <AgentField label={t('agents.mandate.horizon')} hint={t('agents.mandate.horizonHint')}>
          <select
            value={draft.horizon ?? ''}
            onChange={(event) => onChange({ ...draft, horizon: (event.target.value || null) as Horizon | null })}
            className={INPUT}
          >
            <option value="">{t('agents.mandate.notSet')}</option>
            {HORIZONS.map((horizon) => (
              <option key={horizon} value={horizon}>
                {t(`agents.mandate.horizons.${horizon}`)}
              </option>
            ))}
          </select>
        </AgentField>
        <AgentField label={t('agents.mandate.style')}>
          <select
            value={draft.thesisStyle ?? ''}
            onChange={(event) =>
              onChange({ ...draft, thesisStyle: (event.target.value || null) as ThesisStyle | null })
            }
            className={INPUT}
          >
            <option value="">{t('agents.mandate.notSet')}</option>
            {THESIS_STYLES.map((style) => (
              <option key={style} value={style}>
                {t(`agents.mandate.styles.${style}`)}
              </option>
            ))}
          </select>
        </AgentField>
      </div>

      <p className="text-xs text-text-muted">{t('agents.mandate.enforced')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {rule('maxPositionPct', t('agents.mandate.maxPosition'), t('agents.mandate.maxPositionHint'))}
        {rule('cashBufferPct', t('agents.mandate.cashBuffer'), t('agents.mandate.cashBufferHint'))}
        {rule('maxHoldings', t('agents.mandate.maxHoldings'), t('agents.mandate.maxHoldingsHint'))}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.allowEtfs}
          onChange={(event) => onChange({ ...draft, allowEtfs: event.target.checked })}
        />
        {t('agents.mandate.allowEtfs')}
      </label>

      <MarketCaps
        value={draft.marketCaps}
        onChange={(marketCaps) => onChange({ ...draft, marketCaps })}
      />

      {taxonomy.data ? (
        <TaxonomyPicker
          taxonomy={taxonomy.data}
          selection={draft}
          onChange={(selection) => onChange({ ...draft, ...selection })}
          label={t('agents.mandate.sectors')}
          hint={t('agents.mandate.sectorsHint')}
        />
      ) : taxonomy.isPending ? (
        <Spinner label={t('agents.mandate.taxonomyLoading')} />
      ) : (
        <p className="text-xs text-text-muted">{t('agents.mandate.taxonomyUnavailable')}</p>
      )}

      <AgentField label={t('agents.mandate.blocked')} hint={t('agents.mandate.blockedHint')}>
        <input
          value={draft.blockedSymbols}
          onChange={(event) => onChange({ ...draft, blockedSymbols: event.target.value })}
          dir="ltr"
          placeholder={t('agents.mandate.blockedPlaceholder')}
          aria-invalid={problems.has('blockedSymbols')}
          className={`${INPUT} text-start`}
        />
      </AgentField>
    </fieldset>
  );
}

function RiskSlider({
  level,
  band,
  onChange,
}: {
  level: number | null;
  band: RiskBand | null;
  onChange: (level: number | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="text-sm">
      <div className="mb-1 flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-text-muted">
          {t('agents.mandate.risk')}
        </label>
        <output htmlFor={id} className="font-medium">
          {level === null || band === null
            ? t('agents.mandate.notSet')
            : t('agents.mandate.riskValue', { band: t(`agents.mandate.bands.${band}`), level: formatNumber(level) })}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={1}
        max={10}
        step={1}
        value={level ?? 5}
        aria-describedby={`${id}-hint`}
        aria-valuetext={level === null ? t('agents.mandate.notSet') : undefined}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-accent"
      />
      <div className="flex justify-between text-xs text-text-muted">
        <span>{t('agents.mandate.bands.ultraConservative')}</span>
        <span>{t('agents.mandate.bands.aggressive')}</span>
      </div>
      <p id={`${id}-hint`} className="mt-1 text-xs text-text-muted">
        {t('agents.mandate.riskHint')}{' '}
        {level !== null && (
          <button type="button" className="text-accent hover:underline" onClick={() => onChange(null)}>
            {t('agents.mandate.clearRisk')}
          </button>
        )}
      </p>
    </div>
  );
}

function MarketCaps({ value, onChange }: { value: MarketCap[]; onChange: (caps: MarketCap[]) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const toggle = (cap: MarketCap, on: boolean) =>
    onChange(on ? MARKET_CAPS.filter((each) => each === cap || value.includes(each)) : value.filter((each) => each !== cap));
  return (
    <div role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`} className="text-sm">
      <p id={`${id}-label`} className="mb-1 text-text-muted">
        {t('agents.mandate.marketCaps')}
      </p>
      <div className="flex flex-wrap gap-3">
        {MARKET_CAPS.map((cap) => (
          <label key={cap} className="flex items-center gap-1">
            <input type="checkbox" checked={value.includes(cap)} onChange={(event) => toggle(cap, event.target.checked)} />
            {t(`agents.mandate.caps.${cap}`)}
          </label>
        ))}
      </div>
      <p id={`${id}-hint`} className="mt-1 text-xs text-text-muted">
        {t('agents.mandate.marketCapsHint')}
      </p>
    </div>
  );
}
