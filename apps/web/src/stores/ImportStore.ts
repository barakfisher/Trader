import { makeAutoObservable, runInAction } from 'mobx';

import type { ImportCommitResult, ImportMode, ImportPreview, ImportRowStatus } from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
import { t } from '../i18n/index.ts';
import { queryKeys } from '../queries/queryKeys.ts';
import type { RootStore } from './RootStore.ts';

/** Rows in these states can be imported; the rest need the user's attention. */
const IMPORTABLE: ImportRowStatus[] = ['ok', 'ambiguous'];

export class ImportStore {
  open = false;
  preview: ImportPreview | null = null;
  mode: ImportMode = 'merge';
  /** Line numbers the user has selected for import. */
  selected = new Set<number>();
  /** Chosen symbol per line, for rows the user disambiguated. */
  overrides = new Map<number, string>();
  uploading = false;
  committing = false;
  error: string | null = null;
  result: ImportCommitResult | null = null;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  openDialog(): void {
    this.open = true;
    this.reset();
  }

  closeDialog(): void {
    this.open = false;
    this.reset();
  }

  reset(): void {
    this.preview = null;
    this.selected = new Set();
    this.overrides = new Map();
    this.error = null;
    this.result = null;
    this.mode = 'merge';
  }

  setMode(mode: ImportMode): void {
    this.mode = mode;
  }

  toggleRow(line: number): void {
    const next = new Set(this.selected);
    if (next.has(line)) next.delete(line);
    else next.add(line);
    this.selected = next;
  }

  setOverride(line: number, symbol: string): void {
    const next = new Map(this.overrides);
    next.set(line, symbol);
    this.overrides = next;
    // Choosing a candidate is an implicit "yes, import this row".
    if (!this.selected.has(line)) this.toggleRow(line);
  }

  get selectableLines(): number[] {
    return (this.preview?.rows ?? [])
      .filter((row) => IMPORTABLE.includes(row.status))
      .map((row) => row.line);
  }

  get blockedRows() {
    return (this.preview?.rows ?? []).filter((row) => !IMPORTABLE.includes(row.status));
  }

  /** An ambiguous row cannot be imported until a candidate has been picked. */
  get readyLines(): number[] {
    return [...this.selected].filter((line) => {
      const row = this.preview?.rows.find((candidate) => candidate.line === line);
      if (!row) return false;
      if (row.status === 'ambiguous') return this.overrides.has(line);
      return row.status === 'ok';
    });
  }

  async upload(file: File): Promise<void> {
    this.uploading = true;
    this.error = null;
    this.result = null;
    try {
      const form = new FormData();
      form.append('file', file);
      const preview = await api.postForm<ImportPreview>('/imports/preview', form);
      runInAction(() => {
        this.preview = preview;
        // Pre-select everything that is unambiguously importable.
        this.selected = new Set(
          preview.rows.filter((row) => row.status === 'ok').map((row) => row.line),
        );
      });
    } catch (error) {
      runInAction(() => {
        this.error = error instanceof ApiRequestError ? error.message : t('import.readFailed');
      });
    } finally {
      runInAction(() => {
        this.uploading = false;
      });
    }
  }

  async commit(): Promise<void> {
    if (!this.preview) return;
    this.committing = true;
    this.error = null;
    try {
      const result = await api.post<ImportCommitResult>('/imports/commit', {
        previewId: this.preview.previewId,
        mode: this.mode,
        lines: this.readyLines,
        symbolOverrides: Object.fromEntries(this.overrides),
      });
      runInAction(() => {
        this.result = result;
        this.preview = null;
      });
      // Not awaited: the import has succeeded, and the refetch is the
      // dashboard's to show, not a reason to hold the wizard open.
      void this.root.queryClient.invalidateQueries({ queryKey: queryKeys.portfolio });
    } catch (error) {
      runInAction(() => {
        this.error = error instanceof ApiRequestError ? error.message : t('import.failed');
      });
    } finally {
      runInAction(() => {
        this.committing = false;
      });
    }
  }
}
