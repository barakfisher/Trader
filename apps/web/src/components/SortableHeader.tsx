import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

import { useTranslation } from '../i18n/index.ts';
import { SORT_KEYS, firstDirection, nextSort, type HoldingsSort, type SortKey } from '../lib/holdingsSort.ts';

export interface SortProps {
  sort: HoldingsSort | null;
  onSort: (sort: HoldingsSort | null) => void;
}

/**
 * A holdings table's column header that sorts it (M10 decision 21): a button
 * inside the `th`, so a keyboard reaches it, and `aria-sort` on the `th`, so a
 * screen reader says which column orders the table and which way.
 */
export function SortableTh({
  column,
  label,
  end = true,
  sort,
  onSort,
}: SortProps & { column: SortKey; label: string; end?: boolean }) {
  const { t } = useTranslation();
  const active = sort?.key === column ? sort.direction : null;
  const Icon = active === 'asc' ? ArrowUp : active === 'desc' ? ArrowDown : ArrowUpDown;
  return (
    <th
      aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}
      className={`pb-2 pe-3 font-medium ${end ? 'text-end' : ''}`}
    >
      <button
        type="button"
        onClick={() => onSort(nextSort(sort, column))}
        title={t('holdings.sort.by', { column: label })}
        className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-text-primary ${
          active ? 'text-text-primary' : ''
        } ${end ? 'flex-row-reverse' : ''}`}
      >
        {label}
        <Icon className={`size-3 ${active ? '' : 'opacity-40'}`} aria-hidden />
      </button>
    </th>
  );
}

/**
 * The same order on a phone, where the holdings are cards with no headers: a
 * column to sort by, and which way. "Default" is the server's order.
 */
export function SortControl({ sort, onSort, columns }: SortProps & { columns: { key: SortKey; label: string }[] }) {
  const { t } = useTranslation();
  const direction = sort?.direction ?? null;
  return (
    <div className="mb-3 flex items-center gap-2 text-sm">
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 text-text-muted">{t('holdings.sort.label')}</span>
        <select
          value={sort?.key ?? ''}
          onChange={(event) => {
            const key = event.target.value;
            onSort(
              (SORT_KEYS as readonly string[]).includes(key)
                ? { key: key as SortKey, direction: firstDirection(key as SortKey) }
                : null,
            );
          }}
          className="input min-w-0 flex-1"
        >
          <option value="">{t('holdings.sort.default')}</option>
          {columns.map((column) => (
            <option key={column.key} value={column.key}>
              {column.label}
            </option>
          ))}
        </select>
      </label>
      {sort && (
        <button
          type="button"
          onClick={() => onSort({ key: sort.key, direction: direction === 'asc' ? 'desc' : 'asc' })}
          aria-label={t(direction === 'asc' ? 'holdings.sort.ascending' : 'holdings.sort.descending')}
          title={t(direction === 'asc' ? 'holdings.sort.ascending' : 'holdings.sort.descending')}
          className="rounded-md border border-border-subtle p-2 text-text-muted hover:text-text-primary"
        >
          {direction === 'asc' ? <ArrowUp className="size-4" aria-hidden /> : <ArrowDown className="size-4" aria-hidden />}
        </button>
      )}
    </div>
  );
}

/**
 * Every sortable column with its header's words, for the headers and the phone's
 * control. Sentiment is a column only once an agent researches the portfolio
 * (`useSentiments().shown`), so it is offered only then.
 */
export function useSortColumns(withSentiment: boolean): { key: SortKey; label: string }[] {
  const { t } = useTranslation();
  return SORT_KEYS.filter((key) => withSentiment || key !== 'sentiment').map((key) => ({
    key,
    label: t(`holdings.columns.${key}`),
  }));
}

/** Figures align to the end; the symbol and the sentiment word to the start. */
export function alignsEnd(key: SortKey): boolean {
  return key !== 'symbol' && key !== 'sentiment';
}
