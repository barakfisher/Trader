import { makeAutoObservable, runInAction } from 'mobx';

import type { ObservationSeverity, UserSettings, UserSettingsResponse } from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
import { muteEndingIn } from '../lib/notificationSchedule.ts';
import { queryKeys } from '../queries/queryKeys.ts';
import type { RootStore } from './RootStore.ts';

/**
 * The bounds the TTL control offers, mirroring the route's and the column's.
 *
 * The server is the authority and says so with a 422; these exist because a
 * number input needs a floor and a ceiling to be usable at all, and a control
 * that lets someone type 500 only to be refused afterwards is a worse way to
 * learn the rule than one that does not go there.
 */
export const MIN_PROPOSAL_TTL_HOURS = 1;
export const MAX_PROPOSAL_TTL_HOURS = 168;

/**
 * The settings form: the edits made against what the server holds.
 *
 * What is saved is server state, read from the query cache (`saved`); this
 * store holds only `edits`, and the form shows `draft` - the edits, or the saved
 * settings while there are none. Kept apart rather than editing in place, for
 * two reasons that both bite the user. It makes "unsaved changes" a fact the
 * page can state instead of a guess, and it means a failed save leaves their
 * typing on screen - re-rendering from the server on a failure would silently
 * discard what they had just written, which is the expensive direction to fail
 * in. It also means a background re-read of the settings never overwrites a
 * form someone is halfway through.
 */
export class SettingsStore {
  /** The form's changes since the last save or discard. Null while there are none. */
  edits: UserSettings | null = null;

  saving = false;
  /** Why the last save failed. A failed *load* is the query's to report. */
  error: string | null = null;
  /** When the last successful save landed, so the page can confirm it happened. */
  savedAt: Date | null = null;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  /** What the server last told us it holds, or null before the first read. */
  get saved(): UserSettings | null {
    return this.root.settingsCache.data ?? null;
  }

  /** What the form shows. Null exactly when nothing has been read yet. */
  get draft(): UserSettings | null {
    return this.edits ?? this.saved;
  }

  get isDirty(): boolean {
    if (this.saved === null || this.draft === null) return false;
    return (
      this.saved.proposalSeverity !== this.draft.proposalSeverity ||
      this.saved.proposalTtlHours !== this.draft.proposalTtlHours ||
      this.saved.notifySeverity !== this.draft.notifySeverity ||
      this.saved.quietHoursStart !== this.draft.quietHoursStart ||
      this.saved.quietHoursEnd !== this.draft.quietHoursEnd ||
      this.saved.mutedUntil !== this.draft.mutedUntil
    );
  }

  /** Whether quiet hours are configured at all. Both ends move together. */
  get quietHoursEnabled(): boolean {
    return this.draft?.quietHoursStart !== null && this.draft?.quietHoursEnd !== null;
  }

  /**
   * Why the current draft cannot be sent, or null when it can.
   *
   * The pair rule is not listed here because the form cannot express a half-set
   * window: the toggle writes both ends or neither. What remains is what a
   * number input can still produce - an empty box, or a value outside the range
   * a spinner is happy to type past.
   */
  get blockingIssue(): string | null {
    const draft = this.draft;
    if (draft === null) return null;
    if (!Number.isInteger(draft.proposalTtlHours)) {
      return 'How long a proposal stays open must be a whole number of hours.';
    }
    if (
      draft.proposalTtlHours < MIN_PROPOSAL_TTL_HOURS ||
      draft.proposalTtlHours > MAX_PROPOSAL_TTL_HOURS
    ) {
      return `How long a proposal stays open must be between ${MIN_PROPOSAL_TTL_HOURS} and ${MAX_PROPOSAL_TTL_HOURS} hours.`;
    }
    if (draft.quietHoursStart !== null && draft.quietHoursStart === draft.quietHoursEnd) {
      return 'Quiet hours must start and end at different times.';
    }
    return null;
  }

  get canSave(): boolean {
    return this.isDirty && !this.saving && this.blockingIssue === null;
  }

  async save(): Promise<void> {
    if (this.draft === null || this.saving) return;
    this.saving = true;
    this.error = null;
    try {
      const response = await api.put<UserSettingsResponse>('/settings', this.draft);
      // From the response: the server returns the stored row, so the form shows
      // what was written rather than what was typed.
      this.root.queryClient.setQueryData(queryKeys.settings, response.settings);
      runInAction(() => {
        this.edits = null;
        this.savedAt = new Date();
      });
    } catch (error) {
      runInAction(() => {
        this.error =
          error instanceof ApiRequestError ? error.message : 'Could not save your settings.';
      });
    } finally {
      runInAction(() => {
        this.saving = false;
      });
    }
  }

  update(patch: Partial<UserSettings>): void {
    const base = this.draft;
    if (base === null) return;
    this.edits = { ...base, ...patch };
  }

  setProposalSeverity(severity: ObservationSeverity): void {
    this.update({ proposalSeverity: severity });
  }

  setNotifySeverity(severity: ObservationSeverity): void {
    this.update({ notifySeverity: severity });
  }

  setProposalTtlHours(hours: number): void {
    this.update({ proposalTtlHours: hours });
  }

  /**
   * Turning quiet hours on restores the schema's own default window rather than
   * an empty pair, so the toggle can never produce the half-set window the
   * database refuses, and the user is not asked to invent two times to see what
   * the feature does.
   */
  setQuietHoursEnabled(enabled: boolean): void {
    this.update(
      enabled
        ? { quietHoursStart: DEFAULT_QUIET_HOURS.start, quietHoursEnd: DEFAULT_QUIET_HOURS.end }
        : { quietHoursStart: null, quietHoursEnd: null },
    );
  }

  setQuietHours(start: string, end: string): void {
    this.update({ quietHoursStart: start, quietHoursEnd: end });
  }

  /** A one-tap mute, resolved to a wall-clock end here because the API stores one. */
  muteFor(hours: number, now: Date = new Date()): void {
    this.update({ mutedUntil: muteEndingIn(hours, now) });
  }

  clearMute(): void {
    this.update({ mutedUntil: null });
  }

  /** Throw the edits away and go back to what the server holds. */
  discard(): void {
    this.edits = null;
    this.error = null;
  }

  reset(): void {
    this.edits = null;
    this.error = null;
    this.savedAt = null;
  }
}

/** Migration 0006's own default window, reused so the toggle agrees with the schema. */
const DEFAULT_QUIET_HOURS = { start: '22:00', end: '07:00' } as const;
