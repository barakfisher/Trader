/**
 * The narration notice: announced once per crossing of the model/template
 * boundary, judged over the last few explanations rather than one scan.
 *
 * The database is substituted. `recordNarrationState`'s compare-and-insert is
 * SQL and was exercised by hand against Postgres (see the PR); what is pinned
 * here is what the service does with each answer it can give.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  provenance: [] as { narration_source: string; fallback_reason: string | null }[],
  /** What `recordNarrationState` returns: the new row, or null when unchanged. */
  transition: null as { id: string; from_state: string | null; to_state: string } | null,
  recorded: [] as { state: string; reason: string | null }[],
}));

vi.mock('../src/db/queries.js', () => ({
  listRecentNarrationProvenance: vi.fn(async () => db.provenance),
  recordNarrationState: vi.fn(async (_u: string, state: string, reason: string | null) => {
    db.recorded.push({ state, reason });
    return db.transition === null ? null : { ...db.transition, fallback_reason: reason, created_at: new Date() };
  }),
  claimNotification: vi.fn(async () => ({ id: 'notification-1' })),
  settleNotification: vi.fn(async () => undefined),
}));
vi.mock('../src/logger.js', () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const queries = await import('../src/db/queries.js');
const { NARRATION_WINDOW, shouldAnnounce, watchNarration } = await import(
  '../src/services/narrationWatch.js'
);
const { announcementFor, BREAK_SEVERITY, RECOVERY_SEVERITY } = await import(
  '../src/services/narrationNotice.js'
);

/** The user's primary agent; its id is opaque to everything under test. */
const AGENT = '90000000-0000-0000-0000-000000000001';
const USER = '00000000-0000-0000-0000-000000000001';
/** Noon in Jerusalem: outside the 22:00-07:00 quiet window. */
const DAYTIME = new Date('2026-09-17T09:00:00Z');
const SETTINGS = {
  notifySeverity: 'high',
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  mutedUntil: null,
  timezone: 'Asia/Jerusalem',
  language: 'en',
};

const llm = { narration_source: 'llm', fallback_reason: 'none' };
const refused = { narration_source: 'template', fallback_reason: 'unsourced_figures' };
const refusedByProvider = { narration_source: 'template', fallback_reason: 'provider_error' };

function ai(tier: 'free' | 'paid' | 'none' = 'free') {
  return { narrationConfig: vi.fn(async () => ({ tier, model: 'some/model', provider: 'openrouter' })) };
}

function channel() {
  return { channel: 'telegram', send: vi.fn(async () => ({ delivered: true })) };
}

async function watch(aiClient = ai(), notifier = channel()) {
  return watchNarration(USER, AGENT, aiClient as never, notifier as never, SETTINGS, 'run-1', undefined, DAYTIME);
}

beforeEach(() => {
  db.provenance = [];
  db.transition = null;
  db.recorded = [];
  vi.mocked(queries.claimNotification).mockClear();
});

describe('shouldAnnounce', () => {
  it.each([
    [null, 'rejected', false], // the first state ever recorded is a baseline
    ['narrating', 'rejected', true],
    ['narrating', 'unavailable', true],
    ['rejected', 'narrating', true],
    ['narrating', 'off', true],
    // Still templates: the reader was already told.
    ['unavailable', 'rejected', false],
    ['exhausted', 'unavailable', false],
  ])('%s -> %s is announced: %s', (from, to, expected) => {
    expect(shouldAnnounce({ from_state: from, to_state: to })).toBe(expected);
  });
});

describe('announcementFor', () => {
  it('interrupts for a break and waits for the digest otherwise', () => {
    for (const state of ['rejected', 'exhausted', 'unavailable']) {
      expect(announcementFor(state).severity).toBe(BREAK_SEVERITY);
    }
    // `off` is a configuration someone chose, not a fault.
    for (const state of ['narrating', 'off']) {
      expect(announcementFor(state).severity).toBe(RECOVERY_SEVERITY);
    }
  });

  it('contains no figures, because nothing here passed the evidence validator', () => {
    for (const state of ['narrating', 'off', 'rejected', 'exhausted', 'unavailable', 'new-state']) {
      const { headline, explanation } = announcementFor(state);
      expect(`${headline} ${explanation}`).not.toMatch(/\d/);
    }
  });
});

describe('watchNarration', () => {
  it('records the first state as a baseline and says nothing', async () => {
    db.provenance = [refused, refused, refused];
    db.transition = { id: 'tr1', from_state: null, to_state: 'rejected' };
    const notifier = channel();

    expect(await watch(ai(), notifier)).toBe('baseline');
    expect(notifier.send).not.toHaveBeenCalled();
    expect(queries.claimNotification).not.toHaveBeenCalled();
  });

  it('pushes a break, once, as a narration notice', async () => {
    db.provenance = [refused, refused, refused];
    db.transition = { id: 'tr1', from_state: 'narrating', to_state: 'rejected' };
    const notifier = channel();

    expect(await watch(ai(), notifier)).toBe('announced');
    expect(db.recorded).toEqual([{ state: 'rejected', reason: 'unsourced_figures' }]);
    expect(queries.claimNotification).toHaveBeenCalledWith(
      expect.objectContaining({ refKind: 'narration', refId: 'tr1', route: 'push' }),
    );
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(notifier.send).toHaveBeenCalledWith(
      expect.objectContaining({ title: announcementFor('rejected').headline }),
    );
  });

  it('pushes the notice in the user’s language', async () => {
    db.provenance = [refused, refused, refused];
    db.transition = { id: 'tr1', from_state: 'narrating', to_state: 'rejected' };
    const notifier = channel();

    await watchNarration(USER, AGENT, ai() as never, notifier as never, { ...SETTINGS, language: 'he' }, 'run-1', undefined, DAYTIME);

    expect(notifier.send).toHaveBeenCalledWith(
      expect.objectContaining({
        title: announcementFor('rejected', 'he').headline,
        body: announcementFor('rejected', 'he').explanation,
        language: 'he',
      }),
    );
  });

  it('defers a recovery to the digest rather than interrupting', async () => {
    db.provenance = [llm, refused, refused];
    db.transition = { id: 'tr2', from_state: 'rejected', to_state: 'narrating' };
    const notifier = channel();

    expect(await watch(ai(), notifier)).toBe('announced');
    expect(queries.claimNotification).toHaveBeenCalledWith(
      expect.objectContaining({ refKind: 'narration', route: 'digest', channel: 'digest' }),
    );
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('reads any model sentence in the window as the model working', async () => {
    // Two refusals after a success is a model meeting two awkward findings, not
    // an outage. The replayed history had exactly this at 2026-09-24 04:49.
    db.provenance = [refused, refused, llm];
    await watch();
    expect(db.recorded).toEqual([{ state: 'narrating', reason: null }]);
    expect(queries.listRecentNarrationProvenance).toHaveBeenLastCalledWith(USER, NARRATION_WINDOW);
  });

  it('records a change between two template states without a message', async () => {
    db.provenance = [refusedByProvider, refusedByProvider, refusedByProvider];
    db.transition = { id: 'tr3', from_state: 'rejected', to_state: 'unavailable' };
    const notifier = channel();

    expect(await watch(ai(), notifier)).toBe('recorded');
    expect(notifier.send).not.toHaveBeenCalled();
    expect(queries.claimNotification).not.toHaveBeenCalled();
  });

  it('does nothing when the state has not changed', async () => {
    db.provenance = [llm];
    db.transition = null;
    expect(await watch()).toBe('unchanged');
    expect(queries.claimNotification).not.toHaveBeenCalled();
  });

  it('records nothing when the AI service cannot say how narration is configured', async () => {
    // Without the tier, "no model configured" and "the model is failing" look
    // alike, and a wrong reading would be recorded as a transition.
    db.provenance = [refused, refused, refused];
    const failing = { narrationConfig: vi.fn(async () => Promise.reject(new Error('down'))) };

    expect(await watch(failing as never)).toBe('not_measured');
    expect(db.recorded).toEqual([]);
  });

  it('never throws into the scan that called it', async () => {
    vi.mocked(queries.listRecentNarrationProvenance).mockRejectedValueOnce(new Error('db gone'));
    expect(await watch()).toBe('not_measured');
  });
});
