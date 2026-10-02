/**
 * The settings form's own rules: what counts as an unsaved change, what the
 * page is allowed to send, and how a silence is described to the reader.
 *
 * The API client is mocked, as in stores.test.ts. Every sentence asserted here
 * is one the user reads and acts on - "muted for another 2h" is a promise about
 * what will not reach them - so the wording is behaviour, not decoration.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserSettings } from '@traders/shared';

import { i18n } from '../src/i18n/index.ts';

const get = vi.fn();
const post = vi.fn();
const postForm = vi.fn();
const patch = vi.fn();
const put = vi.fn();
const del = vi.fn();

vi.mock('../src/api/client.ts', () => ({
  api: { get, post, postForm, patch, put, delete: del },
  ApiRequestError: class ApiRequestError extends Error {
    constructor(
      message: string,
      readonly status = 500,
      readonly code = 'error',
    ) {
      super(message);
    }
  },
}));

const { RootStore } = await import('../src/stores/RootStore.ts');
const { MAX_PROPOSAL_TTL_HOURS, MIN_PROPOSAL_TTL_HOURS } = await import(
  '../src/stores/SettingsStore.ts'
);
const { ApiRequestError } = await import('../src/api/client.ts');
const { settingsQuery } = await import('../src/queries/settings.ts');
const { queryKeys } = await import('../src/queries/queryKeys.ts');

/** What the settings page's query does on arrival. A failure stays in the query. */
async function readSettings(root: InstanceType<typeof RootStore>) {
  await root.queryClient.fetchQuery(settingsQuery).catch(() => undefined);
}
const {
  MUTE_PRESET_HOURS,
  describeMute,
  describeQuietHours,
  formatDuration,
  isMuted,
  muteEndingIn,
  muteMinutesRemaining,
} = await import('../src/lib/notificationSchedule.ts');
const { SEVERITY_BANDS, SEVERITY_CHOICES, describeSeverityFloor } = await import(
  '../src/lib/severityScale.ts'
);

const STORED: UserSettings = {
  proposalSeverity: 'high',
  proposalTtlHours: 24,
  notifySeverity: 'high',
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  mutedUntil: null,
  language: 'en',
};

function storeWithSettings(settings: UserSettings = STORED) {
  get.mockResolvedValueOnce({ settings });
  const root = new RootStore();
  return root;
}

describe('SettingsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('holds nothing until a read succeeds, then shows what is stored', async () => {
    const root = storeWithSettings();
    expect(root.settings.draft).toBeNull();
    await readSettings(root);
    expect(root.settings.draft).toEqual(STORED);
  });

  it('keeps a failed read distinguishable from an empty result', async () => {
    get.mockRejectedValue(new ApiRequestError('Cannot reach the server.', 0, 'network_error'));
    const root = new RootStore();
    await readSettings(root);
    expect(root.queryClient.getQueryState(queryKeys.settings)?.error?.message).toBe(
      'Cannot reach the server.',
    );
    expect(root.settings.draft).toBeNull();
    // A failed read is the query's to report; the store's error is for saves.
    expect(root.settings.error).toBeNull();
  });

  it('keeps edits in progress when the stored settings are re-read', async () => {
    const root = storeWithSettings();
    await readSettings(root);
    root.settings.setProposalTtlHours(48);

    // Another tab saved a different mute; this form's edit survives the re-read.
    root.queryClient.setQueryData(queryKeys.settings, { ...STORED, mutedUntil: '2026-09-30T00:00:00Z' });
    expect(root.settings.draft?.proposalTtlHours).toBe(48);
    expect(root.settings.saved?.mutedUntil).toBe('2026-09-30T00:00:00Z');
    expect(root.settings.isDirty).toBe(true);
  });

  it('is not dirty until an edit actually changes a value', async () => {
    const root = storeWithSettings();
    await readSettings(root);
    expect(root.settings.isDirty).toBe(false);
    root.settings.setNotifySeverity('high');
    expect(root.settings.isDirty).toBe(false);
    root.settings.setNotifySeverity('info');
    expect(root.settings.isDirty).toBe(true);
  });

  it('sends the whole object, because the endpoint replaces the whole object', async () => {
    const root = storeWithSettings();
    await readSettings(root);
    root.settings.setProposalSeverity('notable');
    put.mockResolvedValueOnce({ settings: { ...STORED, proposalSeverity: 'notable' } });

    await root.settings.save();
    expect(put).toHaveBeenCalledWith('/settings', { ...STORED, proposalSeverity: 'notable' });
    expect(root.settings.isDirty).toBe(false);
    expect(root.settings.savedAt).not.toBeNull();
  });

  it('re-renders from the saved response rather than from what was typed', async () => {
    const root = storeWithSettings();
    await readSettings(root);
    root.settings.setProposalTtlHours(48);
    // The server is the authority on what was stored; if it normalised the
    // value, the form has to show that and not the user's version of it.
    put.mockResolvedValueOnce({ settings: { ...STORED, proposalTtlHours: 12 } });

    await root.settings.save();
    expect(root.settings.draft?.proposalTtlHours).toBe(12);
    expect(root.settings.saved?.proposalTtlHours).toBe(12);
  });

  it('keeps the edits on screen when a save fails', async () => {
    const root = storeWithSettings();
    await readSettings(root);
    root.settings.setProposalTtlHours(48);
    put.mockRejectedValueOnce(new ApiRequestError('Settings rejected.', 422, 'invalid_body'));

    await root.settings.save();
    // Discarding the user's work on a failure is the expensive direction: they
    // would have to reconstruct what they typed to find out what was wrong.
    expect(root.settings.draft?.proposalTtlHours).toBe(48);
    expect(root.settings.isDirty).toBe(true);
    expect(root.settings.error).toBe('Settings rejected.');
  });

  it('discards edits back to the stored object', async () => {
    const root = storeWithSettings();
    await readSettings(root);
    root.settings.setProposalTtlHours(48);
    root.settings.discard();
    expect(root.settings.draft).toEqual(STORED);
    expect(root.settings.isDirty).toBe(false);
  });

  it('refuses to send a TTL outside the range the server enforces', async () => {
    const root = storeWithSettings();
    await readSettings(root);

    root.settings.setProposalTtlHours(MAX_PROPOSAL_TTL_HOURS + 1);
    expect(root.settings.blockingIssue).not.toBeNull();
    expect(root.settings.canSave).toBe(false);

    root.settings.setProposalTtlHours(MIN_PROPOSAL_TTL_HOURS);
    expect(root.settings.blockingIssue).toBeNull();
    expect(root.settings.canSave).toBe(true);
  });

  it('refuses to send an empty quiet-hours window', async () => {
    const root = storeWithSettings();
    await readSettings(root);
    root.settings.setQuietHours('22:00', '22:00');
    expect(root.settings.canSave).toBe(false);
  });

  it('moves both ends of the quiet-hours window together', async () => {
    const root = storeWithSettings();
    await readSettings(root);

    // The half-set window the database refuses must not be reachable from the
    // form at all, so the toggle writes both ends or neither.
    root.settings.setQuietHoursEnabled(false);
    expect(root.settings.draft).toMatchObject({ quietHoursStart: null, quietHoursEnd: null });
    expect(root.settings.quietHoursEnabled).toBe(false);
    expect(root.settings.canSave).toBe(true);

    root.settings.setQuietHoursEnabled(true);
    expect(root.settings.draft?.quietHoursStart).not.toBeNull();
    expect(root.settings.draft?.quietHoursEnd).not.toBeNull();
  });

  it('resolves a one-tap mute to a wall-clock end the API can store', async () => {
    const root = storeWithSettings();
    await readSettings(root);
    const now = new Date('2026-09-17T10:00:00.000Z');

    root.settings.muteFor(MUTE_PRESET_HOURS[0]!, now);
    expect(root.settings.draft?.mutedUntil).toBe(muteEndingIn(MUTE_PRESET_HOURS[0]!, now));

    root.settings.clearMute();
    expect(root.settings.draft?.mutedUntil).toBeNull();
  });

  it('switches the page language only once the server holds the new one', async () => {
    const root = storeWithSettings();
    await readSettings(root);
    root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'UTC', role: 'user', language: 'en' };
    root.settings.setLanguage('he');
    expect(root.settings.isDirty).toBe(true);
    // Chosen but not saved: the page stays in the language that is in force.
    expect(i18n.language).toBe('en');

    put.mockResolvedValueOnce({ settings: { ...STORED, language: 'he' } });
    await root.settings.save();
    expect(put).toHaveBeenCalledWith('/settings', { ...STORED, language: 'he' });
    expect(i18n.language).toBe('he');

    // A failed save leaves the language as it was.
    root.settings.setLanguage('en');
    put.mockRejectedValueOnce(new ApiRequestError('Settings rejected.', 422, 'invalid_body'));
    await root.settings.save();
    expect(i18n.language).toBe('he');

    // Signing out returns the sign-in page to the default.
    post.mockResolvedValueOnce(undefined);
    await root.auth.logout();
    expect(i18n.language).toBe('en');
  });

  it('forgets everything when the session ends', async () => {
    const root = storeWithSettings();
    await readSettings(root);
    root.settings.setProposalTtlHours(48);
    post.mockResolvedValueOnce(undefined);
    await root.auth.logout();
    expect(root.settings.draft).toBeNull();
    expect(root.settings.saved).toBeNull();
    expect(root.settings.edits).toBeNull();
  });
});

describe('notification schedule', () => {
  const now = new Date('2026-09-17T10:00:00.000Z');

  it('counts an elapsed mute as no mute at all', () => {
    const ended = new Date(now.getTime() - 60_000).toISOString();
    expect(muteMinutesRemaining(ended, now)).toBe(0);
    expect(isMuted(ended, now)).toBe(false);
    // The sentence must not claim a silence that has already stopped: the user
    // is about to be notified.
    expect(describeMute(ended, now)).toBe('Notifications are live.');
  });

  it('reports the time left on a live mute', () => {
    const ends = muteEndingIn(2, now);
    expect(isMuted(ends, now)).toBe(true);
    expect(describeMute(ends, now)).toBe('Muted for another 2h.');
  });

  it('treats an unparsable stored mute as no mute rather than as an error', () => {
    expect(muteMinutesRemaining('not a timestamp', now)).toBe(0);
    expect(describeMute(null, now)).toBe('Notifications are live.');
  });

  it('formats a duration coarsely, in the units a mute is chosen in', () => {
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(60)).toBe('1h');
    expect(formatDuration(90)).toBe('1h 30m');
  });

  it('names the wrap when a quiet-hours window runs through midnight', () => {
    expect(describeQuietHours('22:00', '07:00')).toContain('next morning');
    expect(describeQuietHours('13:00', '14:00')).toBe('13:00 to 14:00.');
  });

  it('says plainly that no window means no protected hours', () => {
    expect(describeQuietHours(null, null)).toContain('any hour');
  });
});

describe('severity scale', () => {
  it('offers exactly the ladder the engine emits, lowest floor first', () => {
    expect(SEVERITY_CHOICES.map((choice) => choice.value)).toEqual(['info', 'notable', 'high']);
  });

  it('describes every level, so no choice is offered without its consequence', () => {
    for (const choice of SEVERITY_CHOICES) {
      expect(describeSeverityFloor(choice.value).length).toBeGreaterThan(0);
    }
  });

  it('quotes a band for every rule at every level', () => {
    // A blank cell in this table would read as "this rule never reaches that
    // severity", which is a claim about the engine and not a missing string.
    expect(SEVERITY_BANDS.length).toBeGreaterThan(0);
    for (const band of SEVERITY_BANDS) {
      expect(band.info).not.toBe('');
      expect(band.notable).not.toBe('');
      expect(band.high).not.toBe('');
    }
  });
});
