/**
 * Starting a rescreen: one run key for the button and the CronJob, the run
 * handed to the AI service, and every way it does not start said in words.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/queries.js', () => ({
  claimRun: vi.fn(async () => ({ claimed: true, runId: 'run-1' })),
  finishRun: vi.fn(async () => undefined),
  runKeyExists: vi.fn(async () => false),
  getLatestUniverseLoad: vi.fn(async () => null),
}));

const queries = await import('../src/db/queries.js');
const { RESCREEN_DUE_DAYS, rescreenDueAt, rescreenRunKey, startRescreen } = await import(
  '../src/services/universeRescreen.js'
);

const OPTIONS = { timezone: 'Asia/Jerusalem', trigger: 'admin' };

function ai(answer: unknown) {
  return { rescreen: vi.fn(async () => answer) } as never;
}

describe('a rescreen', () => {
  beforeEach(() => vi.clearAllMocks());

  it("is keyed by the installation's own day, so a click and a CronJob that day are one run", () => {
    // 21:30 UTC on 30 Sep is already 1 Oct in Jerusalem.
    expect(rescreenRunKey('Asia/Jerusalem', new Date('2026-09-30T21:30:00Z'))).toBe(
      'universe-rescreen:2026-10-01',
    );
  });

  it('is handed to the AI service once claimed', async () => {
    const client = ai({ run_id: 'run-1', status: 'started' });
    const started = await startRescreen(client, { ...OPTIONS, now: new Date('2026-10-01T06:00:00Z') });
    expect(started).toEqual({ status: 'running', runId: 'run-1', runKey: 'universe-rescreen:2026-10-01' });
    expect(queries.finishRun).not.toHaveBeenCalled();
  });

  it('does nothing when the key is already claimed, and says by what', async () => {
    vi.mocked(queries.claimRun).mockResolvedValueOnce({
      claimed: false,
      runId: null,
      existingStatus: 'ok',
    });
    const client = ai({});
    const started = await startRescreen(client, OPTIONS);
    expect(started).toMatchObject({ status: 'skipped', reason: 'this run key was already claimed (ok)' });
    expect((client as { rescreen: ReturnType<typeof vi.fn> }).rescreen).not.toHaveBeenCalled();
  });

  it('finishes the run as skipped, with the reason, when the installation cannot rescreen', async () => {
    const reason = 'UNIVERSE_SNAPSHOT_DIR is not set: there is nowhere to write a new snapshot';
    const started = await startRescreen(ai({ run_id: 'run-1', status: 'unavailable', reason }), OPTIONS);
    expect(started).toMatchObject({ status: 'skipped', runId: 'run-1', reason });
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'skipped', { reason });
  });

  it('does not leave the run claimed when the AI service cannot be reached', async () => {
    const client = { rescreen: vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED'))) };
    await expect(startRescreen(client as never, OPTIONS)).rejects.toThrow('ECONNREFUSED');
    expect(queries.finishRun).toHaveBeenCalledWith('run-1', 'failed', { error: 'connect ECONNREFUSED' });
  });
});

describe('a scheduled rescreen', () => {
  const SNAPSHOT = new Date('2026-09-24T12:04:35Z');
  const DUE = rescreenDueAt(SNAPSHOT)!;
  const scheduled = { timezone: 'Asia/Jerusalem', trigger: 'cronjob', scheduled: true };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getLatestUniverseLoad).mockResolvedValue({ snapshot_as_of: SNAPSHOT } as never);
  });

  it('falls due a quarter after the snapshot last loaded', () => {
    expect(DUE.getTime() - SNAPSHOT.getTime()).toBe(RESCREEN_DUE_DAYS * 24 * 60 * 60 * 1000);
    expect(rescreenDueAt(null)).toBeNull();
  });

  it('is not due before then, says until when, and writes no run', async () => {
    const client = ai({});
    const started = await startRescreen(client, { ...scheduled, now: new Date(DUE.getTime() - 60_000) });
    expect(started).toMatchObject({
      status: 'skipped',
      runId: null,
      reason: `not due: the universe loaded is a snapshot of 2026-09-24, and a scheduled rescreen falls due on ${DUE.toISOString().slice(0, 10)}`,
    });
    expect(queries.claimRun).not.toHaveBeenCalled();
  });

  it('rescreens once due', async () => {
    const started = await startRescreen(ai({ run_id: 'run-1', status: 'started' }), {
      ...scheduled,
      now: new Date(DUE.getTime() + 60_000),
    });
    expect(started.status).toBe('running');
  });

  it("is today's run when one exists - a click's, or its own failed one to retry", async () => {
    // Not due, but the button rescreened this morning: the ask joins that run
    // (claimRun answers "already claimed", or retries it if it failed).
    vi.mocked(queries.runKeyExists).mockResolvedValueOnce(true);
    vi.mocked(queries.claimRun).mockResolvedValueOnce({ claimed: false, runId: null, existingStatus: 'ok' });
    const started = await startRescreen(ai({}), { ...scheduled, now: new Date(DUE.getTime() - 60_000) });
    expect(started).toMatchObject({ status: 'skipped', reason: 'this run key was already claimed (ok)' });
    expect(queries.claimRun).toHaveBeenCalled();
  });

  it('is due at once on an installation that has never loaded a snapshot', async () => {
    vi.mocked(queries.getLatestUniverseLoad).mockResolvedValueOnce(null);
    const started = await startRescreen(ai({ run_id: 'run-1', status: 'started' }), scheduled);
    expect(started.status).toBe('running');
  });

  it('is never held back for the button, which means now', async () => {
    const started = await startRescreen(ai({ run_id: 'run-1', status: 'started' }), {
      timezone: 'Asia/Jerusalem',
      trigger: 'admin',
      now: new Date(DUE.getTime() - 60_000),
    });
    expect(started.status).toBe('running');
    expect(queries.getLatestUniverseLoad).not.toHaveBeenCalled();
  });
});
