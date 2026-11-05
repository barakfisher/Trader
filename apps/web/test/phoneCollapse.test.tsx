// @vitest-environment jsdom
/**
 * The long phone pages close (D385). Research: an entry is a line that still
 * states the rating, its agent and its date, and the agent's card holds the
 * intro. Settings and an agent's Settings tab: every card is a line. A wide
 * screen sees none of it. Nothing typed is lost to a close or to a turned phone.
 */

import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';

import type { AgentView, ResearchHolding, ResearchResponse, UserSettingsResponse } from '@traders/shared';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();

vi.mock('../src/api/client.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.ts')>('../src/api/client.ts');
  return {
    ...actual,
    api: { get, post, put, patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  };
});

const { ApiRequestError } = await import('../src/api/client.ts');
const { App } = await import('../src/App.tsx');
const { byOn, ratedOn } = await import('../src/components/SentimentBadge.tsx');
const { createAppRouter } = await import('../src/router.tsx');
const { queryKeys } = await import('../src/queries/queryKeys.ts');
const { CollapsingCards } = await import('../src/components/CollapsingCards.tsx');
const { Card } = await import('../src/components/ui.tsx');
const { ResearchPage } = await import('../src/pages/ResearchPage.tsx');
const { SettingsPage } = await import('../src/pages/SettingsPage.tsx');
const { renderPage, renderWithServerState } = await import('./serverStateHarness.tsx');
const { t } = await import('../src/i18n/index.ts');

const ANALYST = {
  id: '90000000-0000-0000-0000-0000000000a1',
  name: 'Analyst',
  isPrimary: false,
  state: 'active',
} as unknown as AgentView;

const SIMULATED = {
  ...ANALYST,
  persona: null,
  budgetMinor: 1_000_000,
  cashMinor: 832_542,
  currency: 'USD',
  holdingsCount: 1,
  createdAt: '2026-10-05T10:00:00Z',
  scanSchedule: { everyHours: null, preOpen: true, postClose: false },
  maxDecisions: 1,
  runningScan: null,
  llmBudgetMicroUsd: 500_000,
  llmSpentTodayMicroUsd: 108_022,
  scanCost: { microUsd: 36_000, basis: 'measured' },
  waitingForBrief: false,
  mandate: null,
  instructionsConflicts: null,
  scheduling: { enabled: true, nextAt: '2026-10-08T13:00:00Z' },
} as AgentView;

const RATED: Pick<ResearchHolding, 'held' | 'lastAttempt'> & { latest: NonNullable<ResearchHolding['latest']> } = {
  held: true,
  latest: {
    rating: 'bullish',
    rationale: 'CCJ trades at 54.32.',
    findings: ['Steady news.'],
    agentName: 'Analyst',
    ratedAt: '2026-10-23T20:01:00Z',
    stale: false,
  },
  lastAttempt: null,
};

const RESEARCH: ResearchResponse = {
  agent: { id: ANALYST.id, name: 'Analyst', state: 'active' },
  run: {
    id: 'r1',
    trigger: 'manual',
    status: 'done',
    holdings: 3,
    rated: 2,
    startedAt: '2026-10-23T20:00:00Z',
    finishedAt: '2026-10-23T20:05:00Z',
    error: null,
  },
  holdings: [
    { ...RATED, instrumentId: 'i1', symbol: 'CCJ', name: 'Cameco' },
    {
      ...RATED,
      instrumentId: 'i2',
      symbol: 'NXE',
      name: null,
      latest: { ...RATED.latest, rationale: 'NXE fell.', findings: [], stale: true },
      lastAttempt: { status: 'failed', at: '2026-10-23T20:02:00Z' },
    },
    { ...RATED, instrumentId: 'i3', symbol: 'UEC', name: null, latest: null },
  ],
};

const SETTINGS: UserSettingsResponse = {
  settings: {
    proposalSeverity: 'high',
    proposalTtlHours: 24,
    notifySeverity: 'high',
    quietHoursStart: null,
    quietHoursEnd: null,
    mutedUntil: null,
    language: 'en',
  },
};

type Listener = () => void;

let screenIsNarrow = false;

/** A phone, or a screen `setScreen` can turn into something else mid-test. */
function setScreen(narrow: boolean, listeners: Listener[] = []) {
  screenIsNarrow = narrow;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes('reduced-motion') ? true : screenIsNarrow;
    },
    media: query,
    addEventListener: (_: string, listener: Listener) => listeners.push(listener),
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  listeners.forEach((listener) => listener());
}

function respondWith(research: ResearchResponse) {
  get.mockImplementation(async (path: string) => {
    if (path === '/research') return research;
    if (path === '/agents') return { agents: [ANALYST], agentLimit: null };
    if (path === `/agents/${SIMULATED.id}`) return SIMULATED;
    if (path === '/settings') return SETTINGS;
    return new Promise(() => {});
  });
}

const entryButton = (symbol: string) => screen.getByRole('button', { name: t('research.toggleEntry', { symbol }) });
/** Out of the accessibility tree and, by `invisible`, out of the tab order: jsdom has no CSS to ask. */
const isClosed = (element: HTMLElement) =>
  element.closest('[aria-hidden="true"]')?.classList.contains('invisible') ?? false;

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  respondWith(RESEARCH);
});
afterEach(() => {
  cleanup();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('research on a phone', () => {
  beforeEach(() => setScreen(true));

  it('closes an entry to a line that still states the rating, its agent and its date (D254)', async () => {
    renderPage(<ResearchPage />);
    await screen.findByText('CCJ');
    const closedLine = entryButton('CCJ').parentElement!;
    expect(closedLine.textContent).toContain(t('research.ratings.bullish'));
    expect(closedLine.textContent).toContain(t('research.byOn', byOn('Analyst', RATED.latest.ratedAt)));
    expect(entryButton('NXE').parentElement!.textContent).toContain(t('research.staleLong'));
    expect(isClosed(screen.getByText('CCJ trades at 54.32.'))).toBe(true);
    expect(isClosed(screen.getByText('Steady news.'))).toBe(true);
  });

  it('opens one entry at a time', async () => {
    renderPage(<ResearchPage />);
    await screen.findByText('CCJ');
    fireEvent.click(entryButton('CCJ'));
    expect(entryButton('CCJ').getAttribute('aria-expanded')).toBe('true');
    expect(isClosed(screen.getByText('CCJ trades at 54.32.'))).toBe(false);
    fireEvent.click(entryButton('NXE'));
    expect(entryButton('CCJ').getAttribute('aria-expanded')).toBe('false');
    expect(isClosed(screen.getByText('CCJ trades at 54.32.'))).toBe(true);
    expect(isClosed(screen.getByText('NXE fell.'))).toBe(false);
    fireEvent.click(entryButton('NXE'));
    expect(isClosed(screen.getByText('NXE fell.'))).toBe(true);
  });

  it('opens the entry a link names', async () => {
    window.scrollTo = () => {};
    const router = createRouter({
      routeTree: createRootRoute({ component: () => <ResearchPage /> }),
      history: createMemoryHistory({ initialEntries: ['/#NXE'] }),
    });
    renderWithServerState(<RouterProvider router={router} />);
    await screen.findByText('NXE');
    expect(entryButton('NXE').getAttribute('aria-expanded')).toBe('true');
    expect(entryButton('CCJ').getAttribute('aria-expanded')).toBe('false');
    const scrolled = vi.mocked(Element.prototype.scrollIntoView).mock.contexts;
    expect(scrolled).toContain(document.getElementById('research-NXE'));
  });

  it('opens a linked entry whose rating arrives on a later read', async () => {
    respondWith({ ...RESEARCH, holdings: RESEARCH.holdings.map((h) => (h.symbol === 'NXE' ? { ...h, latest: null } : h)) });
    window.scrollTo = () => {};
    const router = createRouter({
      routeTree: createRootRoute({ component: () => <ResearchPage /> }),
      history: createMemoryHistory({ initialEntries: ['/#NXE'] }),
    });
    const { root } = renderWithServerState(<RouterProvider router={router} />);
    await screen.findByText('NXE');
    expect(screen.queryByRole('button', { name: t('research.toggleEntry', { symbol: 'NXE' }) })).toBeNull();
    respondWith(RESEARCH);
    await act(() => root.queryClient.invalidateQueries({ queryKey: queryKeys.research }));
    await waitFor(() => expect(entryButton('NXE').getAttribute('aria-expanded')).toBe('true'));
    await waitFor(() =>
      expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(document.getElementById('research-NXE')),
    );
  });

  it('closes an entry among the holdings when one among the others opens', async () => {
    respondWith({
      ...RESEARCH,
      holdings: [...RESEARCH.holdings, { ...RATED, held: false, instrumentId: 'i4', symbol: 'GM', name: null }],
    });
    renderPage(<ResearchPage />);
    await screen.findByText('GM');
    fireEvent.click(entryButton('CCJ'));
    fireEvent.click(entryButton('GM'));
    expect(entryButton('CCJ').getAttribute('aria-expanded')).toBe('false');
    expect(entryButton('GM').getAttribute('aria-expanded')).toBe('true');
  });

  it('offers nothing to open on a stock with no rating', async () => {
    renderPage(<ResearchPage />);
    await screen.findByText('UEC');
    expect(screen.getByText(t('research.notYet'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('research.toggleEntry', { symbol: 'UEC' }) })).toBeNull();
  });

  it('leaves a failed attempt in sight, because it qualifies the rating', async () => {
    renderPage(<ResearchPage />);
    const attempt = await screen.findByText(t('research.lastAttempt.failed', { date: ratedOn('2026-10-23T20:02:00Z') }));
    expect(isClosed(attempt)).toBe(false);
  });

  it('never folds the disclaimer or the note that a rating is not advice', async () => {
    renderPage(<ResearchPage />);
    await screen.findByText('CCJ');
    expect(isClosed(screen.getByText(t('disclaimer')))).toBe(false);
    expect(isClosed(screen.getByText(t('research.notAdvice')))).toBe(false);
  });

  it('closes the agent card with the intro inside it, and keeps the run reachable', async () => {
    renderPage(<ResearchPage />);
    await screen.findByText('CCJ');
    await screen.findByText(t('research.cost', { count: 3 }));
    const agentCard = screen.getByRole('button', { name: t('research.agentTitle') });
    expect(agentCard.getAttribute('aria-expanded')).toBe('false');
    expect(isClosed(screen.getByText(t('research.intro')))).toBe(true);
    fireEvent.click(agentCard);
    expect(isClosed(screen.getByText(t('research.intro')))).toBe(false);
    expect(isClosed(screen.getByRole('button', { name: t('research.run') }))).toBe(false);
  });

  it.each([
    ['no agent is assigned', { ...RESEARCH, agent: null, run: null }],
    ['a run is going', { ...RESEARCH, run: { ...RESEARCH.run!, status: 'running', finishedAt: null } }],
    ['the last run failed', { ...RESEARCH, run: { ...RESEARCH.run!, status: 'failed' } }],
    ['the last run was stopped', { ...RESEARCH, run: { ...RESEARCH.run!, error: 'budget_reached' } }],
  ] as [string, ResearchResponse][])('opens the agent card by itself when %s', async (_name, research) => {
    respondWith(research);
    renderPage(<ResearchPage />);
    const agentCard = await screen.findByRole('button', { name: t('research.agentTitle') });
    await waitFor(() => expect(agentCard.getAttribute('aria-expanded')).toBe('true'));
  });

  it('opens the agent card when a start is refused', async () => {
    post.mockRejectedValue(new ApiRequestError('refused', 409, 'run_in_progress'));
    renderPage(<ResearchPage />);
    await screen.findByText(t('research.cost', { count: 3 }));
    const agentCard = screen.getByRole('button', { name: t('research.agentTitle') });
    expect(agentCard.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: t('research.run'), hidden: true }));
    await waitFor(() => expect(agentCard.getAttribute('aria-expanded')).toBe('true'));
  });

  it('leaves the agent card closed across a re-read once the user has closed it', async () => {
    const running = { ...RESEARCH, run: { ...RESEARCH.run!, status: 'running', finishedAt: null } } as ResearchResponse;
    respondWith(running);
    const { root } = renderPage(<ResearchPage />);
    const agentCard = await screen.findByRole('button', { name: t('research.agentTitle') });
    await waitFor(() => expect(agentCard.getAttribute('aria-expanded')).toBe('true'));
    fireEvent.click(agentCard);
    await act(() => root.queryClient.invalidateQueries({ queryKey: queryKeys.research }));
    expect(agentCard.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the card again when a run that was closed while going then fails', async () => {
    respondWith({ ...RESEARCH, run: { ...RESEARCH.run!, status: 'running', finishedAt: null } });
    const { root } = renderPage(<ResearchPage />);
    const agentCard = await screen.findByRole('button', { name: t('research.agentTitle') });
    await waitFor(() => expect(agentCard.getAttribute('aria-expanded')).toBe('true'));
    fireEvent.click(agentCard);
    respondWith({ ...RESEARCH, run: { ...RESEARCH.run!, status: 'failed' } });
    await act(() => root.queryClient.invalidateQueries({ queryKey: queryKeys.research }));
    await waitFor(() => expect(agentCard.getAttribute('aria-expanded')).toBe('true'));
  });

  it('does not let the agent card pull the page away from a linked entry', async () => {
    respondWith({ ...RESEARCH, run: { ...RESEARCH.run!, status: 'running', finishedAt: null } });
    window.scrollTo = () => {};
    const router = createRouter({
      routeTree: createRootRoute({ component: () => <ResearchPage /> }),
      history: createMemoryHistory({ initialEntries: ['/#NXE'] }),
    });
    renderWithServerState(<RouterProvider router={router} />);
    const agentCard = await screen.findByRole('button', { name: t('research.agentTitle') });
    await waitFor(() => expect(agentCard.getAttribute('aria-expanded')).toBe('true'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).not.toContain(agentCard.closest('section'));
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(document.getElementById('research-NXE'));
  });

  it('shows the empty state without a tap', async () => {
    respondWith({ ...RESEARCH, holdings: [] });
    renderPage(<ResearchPage />);
    expect(isClosed(await screen.findByText(t('research.noHoldings')))).toBe(false);
  });

  it('says no agent is assigned without a tap', async () => {
    respondWith({ ...RESEARCH, agent: null, run: null });
    renderPage(<ResearchPage />);
    expect(isClosed(await screen.findByText(t('research.unassignedTitle')))).toBe(false);
  });

  it('states a failed read and offers no empty rows', async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/research') throw new Error('down');
      return new Promise(() => {});
    });
    renderPage(<ResearchPage />);
    expect(isClosed(await screen.findByText(t('research.loadFailed')))).toBe(false);
    expect(screen.queryByRole('button', { name: t('research.agentTitle') })).toBeNull();
  });

  it('shows a spinner, and no rows, while it reads', async () => {
    get.mockImplementation(() => new Promise(() => {}));
    renderPage(<ResearchPage />);
    expect(await screen.findByText(t('common.loading'))).toBeTruthy();
    expect(document.querySelector('[aria-expanded]')).toBeNull();
  });
});

describe('research on a wide screen', () => {
  it('has nothing to open and states the reasons at once, with the intro on top', async () => {
    renderPage(<ResearchPage />);
    await screen.findByText('CCJ');
    expect(screen.queryByRole('button', { name: t('research.toggleEntry', { symbol: 'CCJ' }) })).toBeNull();
    expect(screen.queryByRole('button', { name: t('research.agentTitle') })).toBeNull();
    expect(document.querySelector('[aria-expanded]')).toBeNull();
    expect(document.querySelector('[aria-hidden="true"]:not(svg)')).toBeNull();
    expect(screen.getByText('CCJ trades at 54.32.')).toBeTruthy();
    const intro = screen.getByText(t('research.intro'));
    expect(intro.closest('section')).toBeNull();
  });
});

function Typing() {
  const [value, setValue] = useState('');
  return <input aria-label="typed" value={value} onChange={(event) => setValue(event.target.value)} />;
}

function Cards({ attention = null }: { attention?: string | null }) {
  return (
    <CollapsingCards>
      <Card title="First">
        <Typing />
      </Card>
      <Card title="Second" attention={attention}>
        <p>second body</p>
      </Card>
      <Card>
        <p>no title, nothing to tap</p>
      </Card>
    </CollapsingCards>
  );
}

describe('collapsing cards', () => {
  it('starts closed on a phone and opens one at a time', async () => {
    setScreen(true);
    renderPage(<Cards />);
    const first = await screen.findByRole('button', { name: 'First' });
    const second = screen.getByRole('button', { name: 'Second' });
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(first.getAttribute('aria-controls')).toBeTruthy();
    expect(first.closest('h2')).toBeTruthy();
    fireEvent.click(first);
    expect(first.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(second);
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(second.getAttribute('aria-expanded')).toBe('true');
    expect(isClosed(screen.getByText('no title, nothing to tap'))).toBe(false);
  });

  it('keeps what was typed when a card closes', async () => {
    setScreen(true);
    renderPage(<Cards />);
    const first = await screen.findByRole('button', { name: 'First' });
    fireEvent.click(first);
    fireEvent.change(screen.getByLabelText('typed'), { target: { value: 'half a thought' } });
    fireEvent.click(first);
    expect((screen.getByLabelText('typed', { selector: 'input' }) as HTMLInputElement).value).toBe('half a thought');
    expect(isClosed(screen.getByLabelText('typed'))).toBe(true);
  });

  it('keeps what was typed when a phone is turned to a wide screen', async () => {
    const listeners: Listener[] = [];
    setScreen(true, listeners);
    renderPage(<Cards />);
    fireEvent.click(await screen.findByRole('button', { name: 'First' }));
    const input = screen.getByLabelText('typed') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'half a thought' } });
    act(() => setScreen(false, listeners));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'First' })).toBeNull());
    expect(screen.getByLabelText('typed')).toBe(input);
    expect(input.value).toBe('half a thought');
  });

  it('opens a card that needs attention', async () => {
    setScreen(true);
    renderPage(<Cards attention="a reason" />);
    const second = await screen.findByRole('button', { name: 'Second' });
    expect(second.getAttribute('aria-expanded')).toBe('true');
  });

  it('is an ordinary card on a wide screen', async () => {
    renderPage(<Cards />);
    await screen.findByRole('heading', { name: 'First' });
    expect(document.querySelector('button')).toBeNull();
    expect(document.querySelector('[aria-hidden]')).toBeNull();
  });
});

describe('settings on a phone', () => {
  it('lists the cards closed, and leaves the save bar outside them', async () => {
    setScreen(true);
    renderPage(<SettingsPage />);
    const language = await screen.findByRole('button', { name: t('settings.language') });
    expect(language.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: t('settings.notifications') }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: t('accountReset.title') }).getAttribute('aria-expanded')).toBe('false');
    expect(isClosed(screen.getByRole('button', { name: t('settings.saveChanges'), hidden: true }))).toBe(false);
    expect(isClosed(screen.getByRole('combobox', { name: t('settings.interfaceLanguage'), hidden: true }))).toBe(true);
  });

  it('keeps an unsaved change when its card closes, and says so beside the save bar', async () => {
    setScreen(true);
    renderPage(<SettingsPage />);
    const proposals = await screen.findByRole('button', { name: t('settings.proposals') });
    fireEvent.click(proposals);
    const ttl = screen.getByRole('spinbutton', { name: t('settings.ttlInHours') }) as HTMLInputElement;
    fireEvent.change(ttl, { target: { value: '12' } });
    fireEvent.click(proposals);
    expect(ttl.value).toBe('12');
    const unsaved = screen.getByText(t('settings.unsaved'));
    expect(isClosed(unsaved)).toBe(false);
  });
});

describe('settings on a phone, around the cards', () => {
  beforeEach(() => setScreen(true));
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('opens the sign-in card on a Google outcome the page has to state', async () => {
    window.history.replaceState(null, '', '/?oauth=failed');
    renderPage(<SettingsPage />);
    const signIn = await screen.findByRole('button', { name: t('settings.signIn') });
    expect(signIn.getAttribute('aria-expanded')).toBe('true');
  });

  it('leaves it closed on a sign-in that has nothing to state', async () => {
    window.history.replaceState(null, '', '/?oauth=signed_in');
    renderPage(<SettingsPage />);
    const signIn = await screen.findByRole('button', { name: t('settings.signIn') });
    expect(signIn.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps what erases below the save bar', async () => {
    renderPage(<SettingsPage />);
    const reset = await screen.findByRole('button', { name: t('accountReset.title') });
    const data = screen.getByRole('button', { name: t('accountDeletion.dataTitle') });
    const save = screen.getByRole('button', { name: t('settings.saveChanges') });
    expect(save.compareDocumentPosition(reset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reset.compareDocumentPosition(data) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('states a failed read outside the cards', async () => {
    get.mockImplementation(async () => {
      throw new Error('down');
    });
    renderPage(<SettingsPage />);
    expect(isClosed(await screen.findByText(t('settings.loadFailed')))).toBe(false);
    expect(document.querySelector('section h2 button')).toBeNull();
  });

  it('states a failed save with the cards closed', async () => {
    put.mockRejectedValue(new ApiRequestError('save failed here', 500, 'failed'));
    renderPage(<SettingsPage />);
    const proposals = await screen.findByRole('button', { name: t('settings.proposals') });
    fireEvent.click(proposals);
    fireEvent.change(screen.getByRole('spinbutton', { name: t('settings.ttlInHours') }), { target: { value: '12' } });
    fireEvent.click(proposals);
    fireEvent.click(screen.getByRole('button', { name: t('settings.saveChanges') }));
    expect(isClosed(await screen.findByText('save failed here'))).toBe(false);
  });
});

describe("an agent's settings tab on a phone", () => {
  function renderAgentSettings() {
    window.scrollTo = () => {};
    const router = createAppRouter(createMemoryHistory({ initialEntries: [`/agents/${SIMULATED.id}?tab=settings`] }));
    const result = renderWithServerState(<App router={router} />);
    act(() => {
      result.root.auth.user = { id: 'u', baseCurrency: 'USD', timezone: 'Asia/Jerusalem' } as never;
      result.root.auth.initialised = true;
    });
  }

  it('closes the cards, one open at a time', async () => {
    setScreen(true);
    renderAgentSettings();
    const settings = await screen.findByRole('button', { name: t('agents.settings') });
    const model = screen.getByRole('button', { name: t('models.agentTitle') });
    const schedule = screen.getByRole('button', { name: t('agents.scans.settingsTitle') });
    expect([settings, model, schedule].map((card) => card.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false']);
    fireEvent.click(settings);
    fireEvent.click(model);
    expect(settings.getAttribute('aria-expanded')).toBe('false');
    expect(model.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the save and an unsaved change in sight when the form closes', async () => {
    setScreen(true);
    renderAgentSettings();
    const settings = await screen.findByRole('button', { name: t('agents.settings') });
    fireEvent.click(settings);
    const name = screen.getByDisplayValue(SIMULATED.name) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Renamed' } });
    fireEvent.click(settings);
    expect(isClosed(name)).toBe(true);
    expect(name.value).toBe('Renamed');
    const save = screen.getByRole('button', { name: t('agents.save') }) as HTMLButtonElement;
    expect(isClosed(save)).toBe(false);
    expect(save.form).toBe(name.form);
    expect(isClosed(screen.getByText(t('settings.unsaved')))).toBe(false);
  });

  it('keeps the save inside the form on a wide screen, and offers nothing to close', async () => {
    renderAgentSettings();
    await screen.findByRole('heading', { name: t('agents.settings') });
    expect(screen.queryByRole('button', { name: t('agents.settings') })).toBeNull();
    const save = screen.getByRole('button', { name: t('agents.save') });
    expect(save.closest('form')).toBeTruthy();
    expect(save.closest('section')).toBeTruthy();
  });
});

describe('settings on a wide screen', () => {
  it('offers nothing to close', async () => {
    renderPage(<SettingsPage />);
    await screen.findByRole('heading', { name: t('settings.language') });
    expect(screen.queryByRole('button', { name: t('settings.language') })).toBeNull();
    expect(document.querySelector('section [aria-hidden="true"]:not(svg)')).toBeNull();
  });
});
