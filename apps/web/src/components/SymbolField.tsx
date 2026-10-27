import { useEffect, useId, useMemo, useState } from 'react';
import { useCombobox } from 'downshift';
import { Search } from 'lucide-react';

import type { InstrumentSuggestion } from '@traders/shared';

import { useTranslation } from '../i18n/index.ts';
import { assetClassName } from '../lib/assetClass.ts';
import { matchDirectory, NAME_MATCH_MIN_LENGTH, SEARCH_DEBOUNCE_MS } from '../lib/instrumentSuggestions.ts';
import { useInstrumentDirectory, useInstrumentSearch } from '../queries/instruments.ts';

/** The row after the local matches that asks the market instead. */
const SEARCH_MARKET = { searchMarket: true } as const;
type Row = InstrumentSuggestion | typeof SEARCH_MARKET;
const isSearchRow = (row: Row | null): row is typeof SEARCH_MARKET => row !== null && 'searchMarket' in row;

/**
 * The add-holding form's symbol, with suggestions (D324, D325).
 *
 * The installation's own list is matched in the browser on every keystroke.
 * The market-data provider is searched when that list has no match - once
 * typing has paused for SEARCH_DEBOUNCE_MS - or when the user picks the last
 * row, "Search the market": a name the list does know (Elbit, ESLT) can still
 * have listings it does not (ESLT.TA in Tel Aviv). Typing a symbol neither
 * knows is still allowed: the server resolves it on submit, as before.
 * Downshift supplies the WAI-ARIA combobox, as in TaxonomyPicker.
 *
 * `onCommit` fires with a symbol the user settled on - a suggestion chosen, or
 * what was typed when the field is left - so the form can prefill its price.
 */
export function SymbolField({
  value,
  onChange,
  onCommit,
}: {
  value: string;
  onChange: (symbol: string) => void;
  onCommit: (symbol: string) => void;
}) {
  const { t } = useTranslation();
  const directory = useInstrumentDirectory();
  const typed = value.trim();
  const local = useMemo(
    () => matchDirectory(directory.data?.instruments ?? [], value),
    [directory.data, value],
  );

  // The suggestion last chosen: while the field still holds it, nothing is searched or said.
  const [chosen, setChosen] = useState<string | null>(null);
  const settled = chosen !== null && value === chosen;
  // The text the user asked the market about from the last row.
  const [marketFor, setMarketFor] = useState<string | null>(null);
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);

  const directorySettled = directory.isSuccess || directory.isError;
  const askedExplicitly = marketFor !== null && marketFor === typed;
  // A slow directory is not "no match": the market is asked once it has answered.
  const fromProvider = askedExplicitly || (directorySettled && local.length === 0);
  const askProvider =
    !settled && fromProvider && (askedExplicitly || debounced.trim() === typed);
  const remote = useInstrumentSearch(askedExplicitly ? typed : debounced, askProvider);

  const items: Row[] = fromProvider
    ? askProvider
      ? remote.data?.matches ?? []
      : []
    : typed.length >= NAME_MATCH_MIN_LENGTH && !settled
      ? [...local, SEARCH_MARKET]
      : local;

  const { isOpen, highlightedIndex, getLabelProps, getInputProps, getMenuProps, getItemProps } =
    useCombobox<Row>({
      items,
      inputValue: value,
      selectedItem: null,
      itemToString: (item) => (item && !isSearchRow(item) ? item.symbol : ''),
      itemToKey: (item) => (item === null ? null : isSearchRow(item) ? '__search_market__' : item.symbol),
      // Choosing "Search the market" keeps the menu open and the typing as it was.
      stateReducer: (state, { type, changes }) => {
        const picked =
          type === useCombobox.stateChangeTypes.InputKeyDownEnter ||
          type === useCombobox.stateChangeTypes.ItemClick;
        if (picked && isSearchRow(changes.selectedItem ?? null)) {
          return { ...changes, isOpen: true, inputValue: state.inputValue, highlightedIndex: -1 };
        }
        return changes;
      },
      onInputValueChange: ({ inputValue, type }) => {
        if (type === useCombobox.stateChangeTypes.InputChange) onChange((inputValue ?? '').toUpperCase());
      },
      onSelectedItemChange: ({ selectedItem }) => {
        if (!selectedItem) return;
        if (isSearchRow(selectedItem)) {
          setMarketFor(typed);
          return;
        }
        setChosen(selectedItem.symbol);
        onChange(selectedItem.symbol);
        onCommit(selectedItem.symbol);
      },
    });

  const hintId = `${useId()}-hint`;
  const status =
    typed === '' || settled || !fromProvider
      ? null
      : remote.isFetching || !askProvider
        ? t('addHolding.searching')
        : remote.isError
          ? t('addHolding.searchFailed')
          : items.length === 0
            ? t('addHolding.noMatches')
            : t('addHolding.fromMarket');

  return (
    <div className="relative space-y-1">
      <label {...getLabelProps()} className="block text-xs uppercase tracking-wide text-text-muted">
        {t('addHolding.symbol')}
      </label>
      <input
        {...getInputProps({
          required: true,
          placeholder: t('addHolding.symbolPlaceholder'),
          autoComplete: 'off',
          spellCheck: false,
          'aria-describedby': hintId,
          onBlur: () => {
            if (typed) onCommit(typed.toUpperCase());
          },
          // Escape closes the menu and goes no further: the drawer around the form closes on Escape too.
          onKeyDown: (event) => {
            if (event.key === 'Escape' && isOpen && items.length > 0) event.stopPropagation();
          },
        })}
        dir="ltr"
        className="input"
      />
      <ul
        {...getMenuProps()}
        className={`absolute inset-x-0 z-20 mt-1 max-h-72 overflow-auto rounded-md border border-border-subtle bg-surface-raised shadow-lg ${
          isOpen && items.length > 0 ? '' : 'hidden'
        }`}
      >
        {isOpen &&
          items.map((item, index) =>
            isSearchRow(item) ? (
              <li
                key="__search_market__"
                {...getItemProps({ item, index })}
                className={`flex cursor-pointer items-center gap-2 border-t border-border-subtle px-3 py-2 text-sm text-accent ${
                  highlightedIndex === index ? 'bg-surface-hover' : ''
                }`}
              >
                <Search className="size-4 shrink-0" aria-hidden />
                {t('addHolding.searchMarket', { query: typed })}
              </li>
            ) : (
              <li
                key={item.symbol}
                {...getItemProps({ item, index })}
                className={`flex cursor-pointer items-baseline gap-2 px-3 py-2 text-sm ${
                  highlightedIndex === index ? 'bg-surface-hover' : ''
                }`}
              >
                <bdi className="shrink-0 font-medium" dir="ltr">
                  {item.symbol}
                </bdi>
                {/* An English name in its own direction: in a Hebrew row its final "." stays at its end. */}
                <span className="min-w-0 flex-1 truncate text-text-muted">
                  <bdi lang="en" dir="ltr">
                    {item.name ?? ''}
                  </bdi>
                </span>
                <span className="shrink-0 text-[11px] text-text-muted">
                  {[item.exchange, assetClassName(item.assetClass)].filter(Boolean).join(' · ')}
                </span>
              </li>
            ),
          )}
      </ul>
      <span id={hintId} className="block text-[11px] text-text-muted">
        {status ?? t('addHolding.symbolHint')}
      </span>
    </div>
  );
}
