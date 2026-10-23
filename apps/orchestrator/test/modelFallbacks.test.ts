/**
 * A fallback is announced once, through the notification ledger, in the user's
 * language, naming the agent or the scope (D284, D286).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  rows: [] as {
    id: string;
    agent_id: string;
    agent_name: string;
    scope: 'agent' | 'assistant' | 'explain';
    saved_model: string;
    effective_model: string;
  }[],
  language: 'en',
  claims: [] as { refKind: string; refId: string; agentId: string; dedupeKey: string }[],
  announced: [] as string[],
}));

vi.mock('../src/db/queries.js', () => ({
  listUnannouncedModelFallbacks: vi.fn(async () => db.rows),
  markModelFallbackAnnounced: vi.fn(async (_user: string, id: string) => {
    db.announced.push(id);
  }),
  getOrCreateUserSettings: vi.fn(async () => ({
    notify_severity: 'high',
    quiet_hours_start: null,
    quiet_hours_end: null,
    muted_until: null,
    language: db.language,
  })),
  getUser: vi.fn(async () => ({ id: 'user-1', timezone: 'Asia/Jerusalem' })),
  claimNotification: vi.fn(async (record: { refKind: string; refId: string; agentId: string; dedupeKey: string }) => {
    db.claims.push(record);
    return { id: `notification-${db.claims.length}` };
  }),
  settleNotification: vi.fn(async () => undefined),
}));
vi.mock('../src/logger.js', () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const queries = await import('../src/db/queries.js');
const { announceModelFallbacks, MODEL_FALLBACK_SEVERITY } = await import('../src/services/modelFallbacks.js');

const SAVED = 'acme/retired-1';
const EFFECTIVE = 'google/gemini-3.5-flash-lite';

function channel() {
  return { channel: 'telegram', send: vi.fn(async () => ({ delivered: true })) };
}

beforeEach(() => {
  db.rows = [
    { id: 'f1', agent_id: 'agent-1', agent_name: 'Tech Agent', scope: 'agent', saved_model: SAVED, effective_model: EFFECTIVE },
    { id: 'f2', agent_id: 'primary', agent_name: 'Main', scope: 'assistant', saved_model: SAVED, effective_model: EFFECTIVE },
  ];
  db.language = 'en';
  db.claims = [];
  db.announced = [];
});

describe('announceModelFallbacks', () => {
  it('claims each fallback in the ledger under its own agent and marks it announced', async () => {
    const notifier = channel();
    expect(await announceModelFallbacks('user-1', notifier as never)).toBe(2);
    expect(db.claims.map((claim) => [claim.refKind, claim.refId, claim.agentId])).toEqual([
      ['model_fallback', 'f1', 'agent-1'],
      ['model_fallback', 'f2', 'primary'],
    ]);
    expect(db.announced).toEqual(['f1', 'f2']);
    const [first] = notifier.send.mock.calls[0] as unknown as [{ title: string; body: string; severity: string }];
    expect(first.severity).toBe(MODEL_FALLBACK_SEVERITY);
    expect(first.title).toContain('Tech Agent');
    expect(first.title).toContain(SAVED);
    expect(first.body).toContain(EFFECTIVE);
  });

  it("speaks the user's language", async () => {
    db.language = 'he';
    const notifier = channel();
    await announceModelFallbacks('user-1', notifier as never);
    const [, second] = notifier.send.mock.calls.map((call) => (call as unknown as [{ title: string }])[0]);
    expect(second!.title).toContain('שאלות');
  });

  it('does nothing when nothing fell back, and never throws', async () => {
    db.rows = [];
    expect(await announceModelFallbacks('user-1', channel() as never)).toBe(0);
    vi.mocked(queries.listUnannouncedModelFallbacks).mockRejectedValueOnce(new Error('database down'));
    await expect(announceModelFallbacks('user-1', channel() as never)).resolves.toBe(0);
  });
});
