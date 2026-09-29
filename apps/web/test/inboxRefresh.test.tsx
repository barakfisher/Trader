// @vitest-environment jsdom
/**
 * The open inbox re-reads on its own, because a decision can arrive from
 * Telegram at any moment - and stops while one of its own is in flight.
 *
 * TanStack Query skips interval refetches while the page is hidden and reads
 * again when it becomes visible, so the page is marked focused here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';

const get = vi.fn();
const post = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return { ...actual, api: { get, post, put: vi.fn(), postForm: vi.fn() } };
});

const { REFRESH_INTERVAL_MS, useProposalsQuery } = await import('../src/queries/proposals.ts');
const { renderWithServerState } = await import('./serverStateHarness.tsx');

// An observer, as the inbox page is: the hook reads the in-flight count.
const LiveInbox = observer(function LiveInbox() {
  useProposalsQuery({ live: true });
  return null;
});

const openReads = () => get.mock.calls.filter(([url]) => url === '/proposals?state=open').length;

describe('the open inbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    focusManager.setFocused(true);
    get.mockResolvedValue({ proposals: [] });
  });
  afterEach(() => {
    cleanup();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it('re-reads on the interval while it is on screen', async () => {
    renderWithServerState(<LiveInbox />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(openReads()).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS));
    expect(openReads()).toBe(2);
  });

  it('does not re-read while one of its decisions is in flight', async () => {
    const { root } = renderWithServerState(<LiveInbox />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    post.mockReturnValue(new Promise(() => {}));
    void root.proposals.decide('proposal-1', 'approve');
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 3));
    expect(openReads()).toBe(1);
  });

  it('resumes once the decision is answered', async () => {
    const { root } = renderWithServerState(<LiveInbox />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    post.mockResolvedValue({ outcome: 'applied', state: 'rejected', intentId: null });
    await act(() => root.proposals.decide('proposal-1', 'reject'));
    const afterDecision = openReads(); // the initial read, and the re-read the decision asks for
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS));
    expect(openReads()).toBe(afterDecision + 1);
  });
});
