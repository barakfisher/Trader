import { useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { FileUp, X } from 'lucide-react';

import { formatMoney, type ImportRow, type ImportRowStatus } from '@traders/shared';

import { useStore } from '../stores/context.tsx';
import { Button, ErrorNote, Spinner } from './ui.tsx';

const STATUS_STYLES: Record<ImportRowStatus, string> = {
  ok: 'bg-gain/15 text-gain',
  ambiguous: 'bg-warn/15 text-warn',
  unresolved: 'bg-loss/15 text-loss',
  invalid: 'bg-loss/15 text-loss',
  duplicate: 'bg-surface-hover text-text-muted',
};

const STATUS_LABELS: Record<ImportRowStatus, string> = {
  ok: 'ready',
  ambiguous: 'pick one',
  unresolved: 'unknown symbol',
  invalid: 'invalid',
  duplicate: 'duplicate',
};

export const ImportWizard = observer(function ImportWizard() {
  const { import: store, portfolio } = useStore();
  const fileInput = useRef<HTMLInputElement>(null);

  if (!store.open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8">
      <div className="w-full max-w-4xl rounded-xl border border-border-subtle bg-surface-raised">
        <header className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <h2 className="text-sm font-semibold">Import holdings</h2>
          <button type="button" onClick={store.closeDialog} aria-label="Close" className="text-text-muted hover:text-text-primary">
            <X className="size-4" />
          </button>
        </header>

        <div className="space-y-4 p-4">
          {!store.preview && !store.result && (
            <div className="space-y-3">
              <p className="text-sm text-text-muted">
                Upload a CSV or JSON file. Recognised columns:{' '}
                <code className="text-text-primary">symbol</code>,{' '}
                <code className="text-text-primary">quantity</code>,{' '}
                <code className="text-text-primary">cost_basis</code> (per unit),{' '}
                <code className="text-text-primary">currency</code>,{' '}
                <code className="text-text-primary">opened_at</code>,{' '}
                <code className="text-text-primary">notes</code>. Common aliases such as{' '}
                <code className="text-text-primary">ticker</code> or{' '}
                <code className="text-text-primary">shares</code> also work. Nothing is saved until
                you confirm.
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
                  {store.uploading ? 'Reading…' : 'Choose a file'}
                </span>
              </Button>
              {store.uploading && <Spinner label="Parsing and resolving symbols…" />}
            </div>
          )}

          {store.error && <ErrorNote message={store.error} />}

          {store.result && (
            <div className="space-y-3">
              <p className="text-sm">
                Imported <strong>{store.result.created}</strong> new and updated{' '}
                <strong>{store.result.updated}</strong> holdings. {store.result.skipped} row(s)
                skipped.
              </p>
              {store.result.failed.length > 0 && (
                <ul className="space-y-1 text-xs text-loss">
                  {store.result.failed.map((failure) => (
                    <li key={failure.line}>
                      Line {failure.line}: {failure.message}
                    </li>
                  ))}
                </ul>
              )}
              <Button onClick={store.closeDialog}>Done</Button>
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
                        {store.preview!.counts[status]} {STATUS_LABELS[status]}
                      </span>
                    ))}
                </div>

                <label className="flex items-center gap-2 text-xs text-text-muted">
                  Mode
                  <select
                    value={store.mode}
                    onChange={(event) => store.setMode(event.target.value as 'merge' | 'replace')}
                    className="input w-auto"
                  >
                    <option value="merge">Merge into current portfolio</option>
                    <option value="replace">Replace everything</option>
                  </select>
                </label>
              </div>

              {store.mode === 'replace' && (
                <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                  Replace deletes every existing holding before importing. This cannot be undone.
                </p>
              )}

              <div className="max-h-96 overflow-y-auto rounded-lg border border-border-subtle">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-surface-raised text-left uppercase tracking-wide text-text-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">Import</th>
                      <th className="px-3 py-2 font-medium">Line</th>
                      <th className="px-3 py-2 font-medium">Symbol</th>
                      <th className="px-3 py-2 text-right font-medium">Quantity</th>
                      <th className="px-3 py-2 text-right font-medium">Cost / unit</th>
                      <th className="px-3 py-2 font-medium">Status</th>
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
                  {store.readyLines.length} row(s) will be imported.
                  {store.blockedRows.length > 0 &&
                    ` ${store.blockedRows.length} row(s) need attention and will be skipped.`}
                </p>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={store.closeDialog}>
                    Cancel
                  </Button>
                  <Button
                    onClick={store.commit}
                    disabled={store.committing || store.readyLines.length === 0}
                  >
                    {store.committing ? 'Importing…' : `Import ${store.readyLines.length} row(s)`}
                  </Button>
                </div>
              </div>
            </>
          )}

          {portfolio.error && <ErrorNote message={portfolio.error} />}
        </div>
      </div>
    </div>
  );
});

const PreviewRow = observer(function PreviewRow({ row }: { row: ImportRow }) {
  const { import: store } = useStore();
  const selectable = row.status === 'ok' || row.status === 'ambiguous';

  return (
    <tr className="border-t border-border-subtle/60">
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={store.selected.has(row.line)}
          onChange={() => store.toggleRow(row.line)}
          disabled={!selectable || (row.status === 'ambiguous' && !store.overrides.has(row.line))}
          aria-label={`Import line ${row.line}`}
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
            <option value="">Choose…</option>
            {row.candidates.map((candidate) => (
              <option key={candidate.symbol} value={candidate.symbol}>
                {candidate.symbol}
                {candidate.name ? ` — ${candidate.name}` : ''}
              </option>
            ))}
          </select>
        )}
      </td>
      <td className="px-3 py-2 text-right">{row.quantity ?? '—'}</td>
      <td className="px-3 py-2 text-right">
        {row.costBasisMinor === null ? '—' : formatMoney(row.costBasisMinor, row.currency)}
      </td>
      <td className="px-3 py-2">
        <span className={`rounded px-2 py-0.5 ${STATUS_STYLES[row.status]}`}>
          {STATUS_LABELS[row.status]}
        </span>
        {row.issues.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-text-muted">
            {row.issues.map((issue, index) => (
              <li key={`${issue.field}-${index}`}>
                {issue.field}: {issue.message}
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
});
