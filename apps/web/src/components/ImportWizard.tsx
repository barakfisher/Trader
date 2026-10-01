import { useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { FileUp, X } from 'lucide-react';

import type { ImportRow, ImportRowStatus } from '@traders/shared';

import { errorMessage } from '../api/client.ts';
import { formatMoney } from '../i18n/format.ts';
import { Trans, useTranslation } from '../i18n/index.ts';
import { usePortfolioQuery } from '../queries/portfolio.ts';
import { useStore } from '../stores/context.tsx';
import { Button, ErrorNote, Spinner } from './ui.tsx';

const STATUS_STYLES: Record<ImportRowStatus, string> = {
  ok: 'bg-gain/15 text-gain',
  ambiguous: 'bg-warn/15 text-warn',
  unresolved: 'bg-loss/15 text-loss',
  invalid: 'bg-loss/15 text-loss',
  duplicate: 'bg-surface-hover text-text-muted',
};

export const ImportWizard = observer(function ImportWizard() {
  const { import: store } = useStore();
  // A committed import refetches the portfolio; if that fails, say so here,
  // where the user is looking, rather than only on the page behind the dialog.
  const portfolio = usePortfolioQuery();
  const fileInput = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  if (!store.open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8">
      <div className="w-full max-w-4xl rounded-xl border border-border-subtle bg-surface-raised">
        <header className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <h2 className="text-sm font-semibold">{t('import.title')}</h2>
          <button type="button" onClick={store.closeDialog} aria-label={t('common.close')} className="text-text-muted hover:text-text-primary">
            <X className="size-4" />
          </button>
        </header>

        <div className="space-y-4 p-4">
          {!store.preview && !store.result && (
            <div className="space-y-3">
              <p className="text-sm text-text-muted">
                <Trans i18nKey="import.intro" components={{ code: <code className="text-text-primary" /> }} />
              </p>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.json,text/csv,application/json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void store.upload(file);
                }}
              />
              <Button onClick={() => fileInput.current?.click()} disabled={store.uploading}>
                <span className="flex items-center gap-2">
                  <FileUp className="size-4" aria-hidden />
                  {store.uploading ? t('import.reading') : t('import.chooseFile')}
                </span>
              </Button>
              {store.uploading && <Spinner label={t('import.parsing')} />}
            </div>
          )}

          {store.error && <ErrorNote message={store.error} />}

          {store.result && (
            <div className="space-y-3">
              <p className="text-sm">
                <Trans
                  i18nKey="import.result"
                  values={{
                    created: store.result.created,
                    updated: store.result.updated,
                    skipped: t('import.skipped', { count: store.result.skipped }),
                  }}
                  components={{ strong: <strong /> }}
                />
              </p>
              {store.result.failed.length > 0 && (
                <ul className="space-y-1 text-xs text-loss">
                  {store.result.failed.map((failure) => (
                    <li key={failure.line}>
                      {t('import.failedLine', { line: failure.line, message: failure.message })}
                    </li>
                  ))}
                </ul>
              )}
              <Button onClick={store.closeDialog}>{t('common.done')}</Button>
            </div>
          )}

          {store.preview && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-2 text-xs">
                  {(Object.keys(store.preview.counts) as ImportRowStatus[])
                    .filter((status) => store.preview!.counts[status] > 0)
                    .map((status) => (
                      <span key={status} className={`rounded px-2 py-1 ${STATUS_STYLES[status]}`}>
                        {t('import.statusCount', {
                          count: store.preview!.counts[status],
                          status: t(`import.status.${status}`),
                        })}
                      </span>
                    ))}
                </div>

                <label className="flex items-center gap-2 text-xs text-text-muted">
                  {t('import.mode')}
                  <select
                    value={store.mode}
                    onChange={(event) => store.setMode(event.target.value as 'merge' | 'replace')}
                    className="input w-auto"
                  >
                    <option value="merge">{t('import.merge')}</option>
                    <option value="replace">{t('import.replace')}</option>
                  </select>
                </label>
              </div>

              {store.mode === 'replace' && (
                <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                  {t('import.replaceWarning')}
                </p>
              )}

              <div className="max-h-96 overflow-y-auto rounded-lg border border-border-subtle">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-surface-raised text-start uppercase tracking-wide text-text-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t('import.columns.import')}</th>
                      <th className="px-3 py-2 font-medium">{t('import.columns.line')}</th>
                      <th className="px-3 py-2 font-medium">{t('import.columns.symbol')}</th>
                      <th className="px-3 py-2 text-end font-medium">{t('import.columns.quantity')}</th>
                      <th className="px-3 py-2 text-end font-medium">{t('import.columns.costPerUnit')}</th>
                      <th className="px-3 py-2 font-medium">{t('import.columns.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {store.preview.rows.map((row) => (
                      <PreviewRow key={row.line} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-text-muted">
                  {t('import.willImport', { count: store.readyLines.length })}
                  {store.blockedRows.length > 0 &&
                    t('import.needAttention', { count: store.blockedRows.length })}
                </p>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={store.closeDialog}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    onClick={store.commit}
                    disabled={store.committing || store.readyLines.length === 0}
                  >
                    {store.committing
                      ? t('import.importing')
                      : t('import.importRows', { count: store.readyLines.length })}
                  </Button>
                </div>
              </div>
            </>
          )}

          {portfolio.error && (
            <ErrorNote message={errorMessage(portfolio.error, t('common.loadPortfolioFailed'))} />
          )}
        </div>
      </div>
    </div>
  );
});

const PreviewRow = observer(function PreviewRow({ row }: { row: ImportRow }) {
  const { import: store } = useStore();
  const { t } = useTranslation();
  const selectable = row.status === 'ok' || row.status === 'ambiguous';

  return (
    <tr className="border-t border-border-subtle/60">
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={store.selected.has(row.line)}
          onChange={() => store.toggleRow(row.line)}
          disabled={!selectable || (row.status === 'ambiguous' && !store.overrides.has(row.line))}
          aria-label={t('import.importLine', { line: row.line })}
        />
      </td>
      <td className="px-3 py-2 text-text-muted">{row.line}</td>
      <td className="px-3 py-2">
        <div className="font-medium">{row.symbol ?? '—'}</div>
        {row.resolvedInstrument?.name && (
          <div className="text-text-muted">{row.resolvedInstrument.name}</div>
        )}
        {row.status === 'ambiguous' && (
          <select
            value={store.overrides.get(row.line) ?? ''}
            onChange={(event) => store.setOverride(row.line, event.target.value)}
            className="input mt-1 w-auto"
          >
            <option value="">{t('import.choose')}</option>
            {row.candidates.map((candidate) => (
              <option key={candidate.symbol} value={candidate.symbol}>
                {candidate.name
                  ? t('import.candidate', { symbol: candidate.symbol, name: candidate.name })
                  : candidate.symbol}
              </option>
            ))}
          </select>
        )}
      </td>
      <td className="px-3 py-2 text-end">{row.quantity ?? '—'}</td>
      <td className="px-3 py-2 text-end">
        {row.costBasisMinor === null ? '—' : formatMoney(row.costBasisMinor, row.currency)}
      </td>
      <td className="px-3 py-2">
        <span className={`rounded px-2 py-0.5 ${STATUS_STYLES[row.status]}`}>
          {t(`import.status.${row.status}`)}
        </span>
        {row.issues.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-text-muted">
            {row.issues.map((issue, index) => (
              <li key={`${issue.field}-${index}`}>
                {t('import.issue', { field: issue.field, message: issue.message })}
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
});
