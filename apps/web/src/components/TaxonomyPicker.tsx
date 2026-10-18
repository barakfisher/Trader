import { useId, useMemo, useState } from 'react';
import { useCombobox, useMultipleSelection } from 'downshift';
import { X } from 'lucide-react';

import type { UniverseTaxonomyResponse } from '@traders/shared';

import { useTranslation } from '../i18n/index.ts';
import { formatNumber } from '../i18n/format.ts';

/**
 * "Sectors & industries": a multi-select autocomplete over what the universe
 * holds (D164, D167). Downshift supplies the WAI-ARIA combobox - keyboard,
 * focus and announcements (decided 2026-10-18 under convention 5); the grouping
 * by sector and the chips are ours.
 *
 * Names are Yahoo's, in English, in every UI language: they are the same names
 * the server checks and the scan matches, so they are marked `lang="en"`.
 */

export type TaxonomyKind = 'sector' | 'industry' | 'etf_category';

export interface TaxonomyChoice {
  kind: TaxonomyKind;
  name: string;
  instruments: number;
  /** The sector a row is shown under; null for a sector itself and a category with none. */
  group: string | null;
}

export interface TaxonomySelection {
  sectors: string[];
  industries: string[];
  etfCategories: string[];
}

const key = (choice: Pick<TaxonomyChoice, 'kind' | 'name'>) => `${choice.kind}:${choice.name}`;

/** Every choice, in the order the menu shows them: each sector, then its rows; then sectorless categories. */
export function taxonomyChoices(taxonomy: UniverseTaxonomyResponse): TaxonomyChoice[] {
  const choices: TaxonomyChoice[] = [];
  for (const sector of taxonomy.sectors) {
    choices.push({ kind: 'sector', name: sector.name, instruments: sector.instruments, group: null });
    for (const entry of sector.industries) choices.push({ kind: 'industry', ...entry, group: sector.name });
    for (const entry of sector.etfCategories) choices.push({ kind: 'etf_category', ...entry, group: sector.name });
  }
  for (const entry of taxonomy.etfCategories) choices.push({ kind: 'etf_category', ...entry, group: null });
  return choices;
}

function selectedChoices(selection: TaxonomySelection, choices: TaxonomyChoice[]): TaxonomyChoice[] {
  const byKey = new Map(choices.map((choice) => [key(choice), choice]));
  const wanted: Pick<TaxonomyChoice, 'kind' | 'name'>[] = [
    ...selection.sectors.map((name) => ({ kind: 'sector' as const, name })),
    ...selection.industries.map((name) => ({ kind: 'industry' as const, name })),
    ...selection.etfCategories.map((name) => ({ kind: 'etf_category' as const, name })),
  ];
  // A stored name a later rescreen retired is still shown, with no count, so it can be removed.
  return wanted.map((choice) => byKey.get(key(choice)) ?? { ...choice, instruments: 0, group: null });
}

function toSelection(choices: TaxonomyChoice[]): TaxonomySelection {
  const names = (kind: TaxonomyKind) => choices.filter((choice) => choice.kind === kind).map((choice) => choice.name);
  return { sectors: names('sector'), industries: names('industry'), etfCategories: names('etf_category') };
}

export function TaxonomyPicker({
  taxonomy,
  selection,
  onChange,
  label,
  hint,
}: {
  taxonomy: UniverseTaxonomyResponse;
  selection: TaxonomySelection;
  onChange: (selection: TaxonomySelection) => void;
  label: string;
  hint: string;
}) {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState('');
  const choices = useMemo(() => taxonomyChoices(taxonomy), [taxonomy]);
  const selected = selectedChoices(selection, choices);
  const chosen = new Set(selected.map(key));
  const query = inputValue.trim().toLowerCase();
  const items = choices.filter(
    (choice) =>
      !chosen.has(key(choice)) &&
      (query === '' || choice.name.toLowerCase().includes(query) || (choice.group ?? '').toLowerCase().includes(query)),
  );

  const { getSelectedItemProps, getDropdownProps, removeSelectedItem } = useMultipleSelection<TaxonomyChoice>({
    selectedItems: selected,
    itemToKey: (choice) => (choice ? key(choice) : null),
    onSelectedItemsChange: ({ selectedItems }) => onChange(toSelection(selectedItems)),
  });

  const { isOpen, highlightedIndex, getLabelProps, getMenuProps, getInputProps, getItemProps } =
    useCombobox<TaxonomyChoice>({
      items,
      itemToString: (choice) => choice?.name ?? '',
      itemToKey: (choice) => (choice ? key(choice) : null),
      inputValue,
      selectedItem: null,
      // Choosing keeps the menu open on the next match: several picks in a row is the common case.
      stateReducer: (_state, { changes, type }) => {
        if (
          type === useCombobox.stateChangeTypes.InputKeyDownEnter ||
          type === useCombobox.stateChangeTypes.ItemClick
        ) {
          return { ...changes, isOpen: true, highlightedIndex: _state.highlightedIndex, inputValue: '' };
        }
        if (type === useCombobox.stateChangeTypes.InputBlur) return { ...changes, selectedItem: null };
        return changes;
      },
      onStateChange: ({ type, selectedItem, inputValue: typed }) => {
        // Not on blur: leaving the field must never add whatever happened to be highlighted.
        if (
          (type === useCombobox.stateChangeTypes.InputKeyDownEnter ||
            type === useCombobox.stateChangeTypes.ItemClick) &&
          selectedItem
        ) {
          onChange(toSelection([...selected, selectedItem]));
          setInputValue('');
        } else if (type === useCombobox.stateChangeTypes.InputChange) {
          setInputValue(typed ?? '');
        }
      },
    });

  const kindLabel = (kind: TaxonomyKind) => t(`agents.mandate.kinds.${kind}`);
  const hintId = `${useId()}-hint`;
  // The heading a row sits under: a sector heads itself, a sectorless category sits under "No sector".
  const groupOf = (choice: TaxonomyChoice) =>
    choice.kind === 'sector' ? choice.name : (choice.group ?? t('agents.mandate.noSector'));

  return (
    <div className="text-sm">
      <label {...getLabelProps()} className="mb-1 block text-text-muted">
        {label}
      </label>
      <div className="rounded-md border border-border-subtle bg-surface px-2 py-1.5">
        {selected.length > 0 && (
          <ul className="mb-1 flex flex-wrap gap-1" aria-label={t('agents.mandate.selected')}>
            {selected.map((choice, index) => (
              <li
                key={key(choice)}
                {...getSelectedItemProps({ selectedItem: choice, index })}
                className="flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-xs text-text-primary"
              >
                <bdi lang="en">{choice.name}</bdi>
                <span className="text-text-muted">· {kindLabel(choice.kind)}</span>
                <button
                  type="button"
                  className="rounded-full hover:text-loss"
                  aria-label={t('agents.mandate.remove', { name: choice.name })}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeSelectedItem(choice);
                  }}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          {...getInputProps(getDropdownProps({ preventKeyAction: isOpen }))}
          placeholder={t('agents.mandate.searchPlaceholder')}
          aria-describedby={hintId}
          className="w-full bg-transparent px-1 py-1 outline-none"
        />
      </div>
      <ul
        {...getMenuProps()}
        className={`mt-1 max-h-64 overflow-auto rounded-md border border-border-subtle bg-surface-raised ${
          isOpen && items.length > 0 ? '' : 'hidden'
        }`}
      >
        {isOpen &&
          items.map((choice, index) => {
            // A row names its group when the row above is in another one - when the sector
            // itself was filtered out or already chosen, the rows still say where they belong.
            const previous = items[index - 1];
            const showGroup = choice.kind !== 'sector' && (!previous || groupOf(previous) !== groupOf(choice));
            return (
              <li
                key={key(choice)}
                {...getItemProps({ item: choice, index })}
                className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 ${
                  highlightedIndex === index ? 'bg-surface-hover' : ''
                } ${choice.kind === 'sector' ? 'font-medium' : 'ps-6'}`}
              >
                <span>
                  {showGroup && (
                    <span className="me-2 text-xs text-text-muted">
                      <bdi lang={choice.group ? 'en' : undefined}>{groupOf(choice)}</bdi> ›
                    </span>
                  )}
                  <bdi lang="en">{choice.name}</bdi>{' '}
                  <span className="text-xs text-text-muted">· {kindLabel(choice.kind)}</span>
                </span>
                <span className="text-xs text-text-muted">{formatNumber(choice.instruments)}</span>
              </li>
            );
          })}
      </ul>
      <p id={hintId} className="mt-1 text-xs text-text-muted">
        {hint}
      </p>
    </div>
  );
}
