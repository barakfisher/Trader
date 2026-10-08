// @vitest-environment jsdom
/**
 * The allocation donut opens by holding, remembers the viewer's choice, and
 * still draws when the browser refuses storage.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

import type { PortfolioResponse } from '@traders/shared';

const get = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>(
    '../src/api/client.ts',
  );
  return { ...actual, api: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), postForm: vi.fn() } };
});

const { AllocationChart } = await import('../src/components/AllocationChart.tsx');
const { ALLOCATION_GROUPING_KEY } = await import(
  '../src/lib/allocationGrouping.ts'
);
const { renderWithServerState } = await import('./serverStateHarness.tsx');

const portfolio: PortfolioResponse = {
  summary: {
    baseCurrency: 'USD',
    totalValueMinor: 100000,
    totalCostMinor: 90000,
    pnlMinor: 10000,
    pnlPct: 11.11,
    dayChangeMinor: 0,
    dayChangePct: 0,
    holdingsCount: 2,
    pricedCount: 2,
    unpricedSymbols: [],
    degraded: false,
    asOf: '2026-10-08T10:00:00Z',
  },
  holdings: [],
  allocationByInstrument: [
    { key: 'instrument:VOO', label: 'VOO', valueMinor: 60000, weightPct: 60 },
    { key: 'instrument:NVDA', label: 'NVDA', valueMinor: 40000, weightPct: 40 },
  ],
  allocationByAssetClass: [{ key: 'crypto', label: 'Crypto', valueMinor: 100000, weightPct: 100 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  get.mockResolvedValue(portfolio);
  // jsdom has no layout, so no ResizeObserver; the chart's container needs one to mount.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed');

it('opens by holding when nothing was chosen before', async () => {
  renderWithServerState(<AllocationChart />);

  expect(await screen.findByText('NVDA')).toBeTruthy();
  expect(pressed('By holding')).toBe('true');
  expect(pressed('By class')).toBe('false');
});

it('remembers the last choice for the next visit', async () => {
  const first = renderWithServerState(<AllocationChart />);
  fireEvent.click(await screen.findByRole('button', { name: 'By class' }));
  expect(window.localStorage.getItem(ALLOCATION_GROUPING_KEY)).toBe('assetClass');
  first.unmount();

  renderWithServerState(<AllocationChart />);
  expect(await screen.findByText('Crypto')).toBeTruthy();
  expect(pressed('By class')).toBe('true');
});

it('draws the default when storage throws', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  renderWithServerState(<AllocationChart />);

  expect(await screen.findByText('NVDA')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'By class' }));
  expect(await screen.findByText('Crypto')).toBeTruthy();
});
