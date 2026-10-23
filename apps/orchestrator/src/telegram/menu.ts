/**
 * The bot's menu (M11 slice A1, D269-D272): `/help` and the read-only views
 * its buttons open - the real portfolio, alerts and mute, what is pending, and
 * each simulated agent with its last scan.
 *
 * **A command sends; a button edits.** `/portfolio` posts a new message, and
 * every tap on it rewrites that same message in place (D270), so moving about
 * the menu leaves one message behind rather than a column of them. Because an
 * edited message can sit in the chat for days, every view that shows data says
 * when it was read and carries Refresh, and every tap reads afresh.
 *
 * **Read for the tapping chat's user, always.** Menu buttons are unsigned
 * (`menuData.ts`); the binding of the chat that tapped names the user, and an
 * agent is looked up under that user. A button forwarded to someone else's
 * chat shows them their own data, and an agent that is not theirs is "gone".
 *
 * Nothing here spends money or changes an agent: those buttons are slice A2,
 * signed. The quick mutes change only the tapper's own mute.
 */

import {
  formatMoney,
  MAX_SCAN_EVERY_HOURS,
  MIN_SCAN_EVERY_HOURS,
  REGULAR_SESSION_MINUTES,
  scansPerDay,
  type AgentScanSummary,
  type ScanSchedule,
} from '@traders/shared';
import type { AiClient } from '@traders/shared/ai';

import type { Config } from '../config.js';
import {
  getAgent,
  getOrCreateUserSettings,
  getUser,
  listAgents,
  listAgentScans,
  listHoldings,
  listProposals,
  muteUntil,
  primaryAgentId,
  type AgentRow,
} from '../db/queries.js';
import { logger } from '../logger.js';
import { isolated, messagesFor, observationTextIn, type Messages } from '../notify/messages.js';
import { readyToScan } from '../services/agentReadiness.js';
import { valueAgentAccount } from '../services/agentAccount.js';
import { schedulingOf } from '../services/agentScheduling.js';
import { effectiveState } from '../services/proposalState.js';
import { factsOf } from '../services/proposals.js';
import { scheduleOf, slotsOf, type ScanSlot, type Session } from '../services/scanSchedule.js';
import { scanBlocked } from '../services/manualScan.js';
import { scanCostOf } from '../services/scanCost.js';
import { toScanSummary } from '../services/scanSummary.js';
import { valuePortfolio } from '../services/valuation.js';
import type { InlineButton, InlineKeyboard, TelegramNotifier } from './client.js';
import { encodeAgentActionData, type AgentActionPayload } from './agentActionToken.js';
import { encodeMenuData, QUICK_MUTE_HOURS, type MenuTap, type MenuView } from './menuData.js';

/** How many open proposals `/pending` lists; the rest are in the app. */
export const PENDING_LIST_LIMIT = 10;

/** A problem or an error is shown up to this many characters: the chat is not the transcript. */
export const LOG_TEXT_LIMIT = 300;

export interface MenuDeps {
  config: Config;
  ai: AiClient;
  telegram: TelegramNotifier;
}

interface Reader {
  userId: string;
  messages: Messages;
  timezone: string;
  now: Date;
}

export interface Screen {
  text: string;
  keyboard: InlineKeyboard;
}

function tapButton(text: string, tap: MenuTap): InlineButton {
  return { text, callback_data: encodeMenuData(tap) };
}

/** A signed agent button (M11 A2, `agentActionToken.ts`); none when the installation signs nothing. */
function actionButton(text: string, payload: AgentActionPayload, deps: MenuDeps, now: Date): InlineButton[] {
  const secret = deps.config.TELEGRAM_SIGNING_SECRET;
  return secret ? [{ text, callback_data: encodeAgentActionData(payload, secret, now) }] : [];
}

/** Whether *Run a scan now* is offered: the agent could start one, and none is running. */
function runnable(agent: AgentRow): boolean {
  return scanBlocked(agent) === null && agent.running_scan === null;
}

/** Refresh this view, and go back to `back` (the menu unless said otherwise). */
function footer(reader: Reader, view: MenuView, back?: { text: string; view: MenuView }): InlineButton[] {
  const { buttons } = reader.messages.menu;
  return [tapButton(buttons.refresh, view), tapButton(back?.text ?? buttons.menu, back?.view ?? { view: 'help' })];
}

/** `14:05` today in the reader's zone; with the weekday and date on any other day. */
export function clock(at: Date, reader: Pick<Reader, 'messages' | 'timezone' | 'now'>): string {
  const day = (date: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: reader.timezone, dateStyle: 'short' }).format(date);
  const sameDay = day(at) === day(reader.now);
  return new Intl.DateTimeFormat(reader.messages.locale, {
    timeZone: reader.timezone,
    ...(sameDay ? {} : { weekday: 'short', day: 'numeric', month: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

function money(minor: number, currency: string, messages: Messages): string {
  return formatMoney(minor, currency, { locale: messages.numberLocale });
}

/** A change says its sign: `+$12.00`, `-$3.10`. */
function signedMoney(minor: number, currency: string, messages: Messages): string {
  return `${minor > 0 ? '+' : ''}${money(minor, currency, messages)}`;
}

function signedPercent(percent: number, messages: Messages): string {
  return new Intl.NumberFormat(messages.numberLocale, {
    style: 'percent',
    signDisplay: 'exceptZero',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(percent / 100);
}

/**
 * Model spend is kept in micro-USD; shown to the cent, rounded once. A cost
 * under half a cent is `<$0.01`, not `$0.00`: a scan that cost something did
 * not run for free.
 */
export function microUsd(micro: number, messages: Messages): string {
  const cents = Math.round(micro / 10_000);
  return cents === 0 && micro > 0 ? `<${money(1, 'USD', messages)}` : money(cents, 'USD', messages);
}

function clip(text: string, limit = LOG_TEXT_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * A regular session (09:30-16:00 New York), for naming a schedule's slots: the
 * scheduler's own `slotsOf`, so the names said here are the slots that run.
 */
const REGULAR_SESSION: Session = {
  day: '2026-01-05',
  opens_at: '2026-01-05T14:30:00Z',
  closes_at: new Date(Date.parse('2026-01-05T14:30:00Z') + REGULAR_SESSION_MINUTES * 60_000).toISOString(),
  early_close: false,
};

/** The slots a schedule runs on a regular trading day, in order. */
export function slotsOfSchedule(row: Pick<AgentRow, 'scan_every_hours' | 'scan_pre_open' | 'scan_post_close'>): ScanSlot[] {
  return slotsOf(scheduleOf(row), REGULAR_SESSION).map((due) => due.slot);
}

function helpScreen(reader: Reader, linkBase: string | null): Screen {
  const { menu, openInApp } = reader.messages;
  return {
    text: menu.help,
    keyboard: [
      [tapButton(menu.buttons.portfolio, { view: 'portfolio' }), tapButton(menu.buttons.agents, { view: 'agents' })],
      [tapButton(menu.buttons.status, { view: 'status' }), tapButton(menu.buttons.pending, { view: 'pending' })],
      ...(linkBase === null ? [] : [[{ text: openInApp, url: linkBase }]]),
    ],
  };
}

async function portfolioScreen(reader: Reader, ai: AiClient): Promise<Screen> {
  const { messages } = reader;
  const text = messages.menu.portfolio;
  const user = await getUser(reader.userId);
  const rows = await listHoldings(reader.userId, await primaryAgentId(reader.userId));
  const lines = [text.title];
  if (rows.length === 0) {
    lines.push(text.empty);
  } else {
    const { summary } = await valuePortfolio(rows, { baseCurrency: user?.base_currency ?? 'USD', ai });
    const currency = summary.baseCurrency;
    lines.push(text.value(money(summary.totalValueMinor, currency, messages)));
    lines.push(
      summary.dayChangeMinor === null || summary.dayChangePct === null
        ? text.todayUnknown
        : text.today(signedMoney(summary.dayChangeMinor, currency, messages), signedPercent(summary.dayChangePct, messages)),
    );
    lines.push(text.holdings(summary.holdingsCount, summary.pricedCount));
    if (summary.unpricedSymbols.length > 0) lines.push(text.unpriced(summary.unpricedSymbols));
    else if (summary.degraded) lines.push(text.stale);
  }
  lines.push('', text.agentsApart, messages.menu.asOf(clock(reader.now, reader)));
  return { text: lines.join('\n'), keyboard: [footer(reader, { view: 'portfolio' })] };
}

async function statusScreen(reader: Reader): Promise<Screen> {
  const { messages } = reader;
  const text = messages.menu.status;
  const settings = await getOrCreateUserSettings(reader.userId);
  const muted = settings.muted_until !== null && settings.muted_until.getTime() > reader.now.getTime();
  const lines = [
    text.title,
    text.alertingFrom(messages.severities[settings.notify_severity] ?? settings.notify_severity),
    muted ? text.mutedUntil(clock(settings.muted_until!, reader)) : text.notMuted,
  ];
  if (settings.quiet_hours_start !== null && settings.quiet_hours_end !== null) {
    lines.push(text.quietHours(settings.quiet_hours_start, settings.quiet_hours_end));
  }
  lines.push('', messages.menu.asOf(clock(reader.now, reader)));
  const mutes = [
    ...QUICK_MUTE_HOURS.map((hours) => tapButton(messages.menu.buttons.mute(hours), { view: 'mute', hours })),
    ...(muted ? [tapButton(messages.menu.buttons.unmute, { view: 'mute', hours: 0 })] : []),
  ];
  return { text: lines.join('\n'), keyboard: [mutes, footer(reader, { view: 'status' })] };
}

async function pendingScreen(reader: Reader, language: string): Promise<Screen> {
  const { messages } = reader;
  const open = await listProposals(reader.userId, { open: true, limit: PENDING_LIST_LIMIT });
  const live = open
    .map((row) => ({ row, state: effectiveState(factsOf(row), reader.now) }))
    .filter(({ state }) => state !== 'expired');
  const lines =
    live.length === 0
      ? [messages.nothingPending]
      : [
          messages.menu.pending.title,
          ...live.map(({ row, state }) => {
            const headline = observationTextIn(row, language).headline;
            return state === 'snoozed' ? `• ${headline} (${messages.menu.pending.states.snoozed})` : `• ${headline}`;
          }),
        ];
  lines.push('', messages.menu.asOf(clock(reader.now, reader)));
  return { text: lines.join('\n'), keyboard: [footer(reader, { view: 'pending' })] };
}

/** The simulated agents a user can see here: not the real portfolio, not archived. */
function visibleAgent(row: AgentRow | null): row is AgentRow {
  return row !== null && !row.is_primary && row.state !== 'archived';
}

async function agentsScreen(reader: Reader): Promise<Screen> {
  const { messages } = reader;
  const agents = (await listAgents(reader.userId)).filter(visibleAgent);
  const text = messages.menu.agents;
  const rows = agents.map((agent) => {
    const mark = agent.running_scan !== null ? '🔄' : agent.state === 'paused' ? '⏸' : '▶️';
    // The name is the user's own text, in either script: isolated, as a topic label is.
    const label = `${mark} ${isolated(agent.name)} · ${text.scansADay(scansPerDay(scheduleOf(agent)))}`;
    return [tapButton(label, { view: 'agent', agentId: agent.id })];
  });
  return {
    text: [text.title, agents.length === 0 ? text.empty : text.choose, '', messages.menu.asOf(clock(reader.now, reader))].join('\n'),
    keyboard: [...rows, footer(reader, { view: 'agents' })],
  };
}

async function agentScreen(reader: Reader, agent: AgentRow, deps: MenuDeps): Promise<Screen> {
  const { messages } = reader;
  const { buttons } = messages.menu;
  const signs = Boolean(deps.config.TELEGRAM_SIGNING_SECRET);
  const text = messages.menu.agent;
  const lines = [`🤖 ${isolated(agent.name)}`, text.states[agent.state as 'active' | 'paused'] ?? agent.state];
  if (agent.running_scan !== null) lines.push(text.running(clock(new Date(agent.running_scan.started_at), reader)));

  const slots = slotsOfSchedule(agent);
  lines.push(slots.length === 0 ? text.onlyWhenAsked : text.schedule(slots.map(messages.scheduledScans.slot)));
  if (!readyToScan(agent)) {
    lines.push(text.waitingForBrief);
  } else if (agent.state === 'active' && slots.length > 0) {
    if (!deps.config.ENABLE_SCHEDULED_SCANS) {
      lines.push(text.notScheduledHere);
    } else {
      const { nextAt } = await schedulingOf(agent, true, deps.ai);
      lines.push(nextAt === null ? text.nextScanUnknown : text.nextScan(clock(new Date(nextAt), reader)));
    }
  }

  const account = await valueAgentAccount(agent, await listHoldings(reader.userId, agent.id), {
    ai: deps.ai,
    baseCurrency: agent.currency,
  });
  lines.push('', text.cash(money(account.cashMinor, agent.currency, messages), money(account.depositsMinor, agent.currency, messages)));
  if (account.netWorthMinor !== null && account.pnlMinor !== null) {
    lines.push(
      text.netWorth(
        money(account.netWorthMinor, agent.currency, messages),
        signedMoney(account.pnlMinor, agent.currency, messages),
        account.pnlPct === null ? '—' : signedPercent(account.pnlPct, messages),
      ),
    );
  } else {
    lines.push(text.unpriced(account.portfolio.summary.unpricedSymbols));
  }
  lines.push(text.holdings(account.portfolio.summary.holdingsCount));
  lines.push(
    text.spentToday(microUsd(Number(agent.llm_spent_today_micro_usd), messages), microUsd(Number(agent.llm_budget_micro_usd), messages)),
  );
  lines.push('', messages.menu.asOf(clock(reader.now, reader)));
  return {
    text: lines.join('\n'),
    keyboard: [
      [
        ...(runnable(agent) && signs ? [tapButton(buttons.runScan, { view: 'runConfirm', agentId: agent.id })] : []),
        ...(agent.state === 'active'
          ? actionButton(buttons.pause, { agentId: agent.id, action: 'pause' }, deps, reader.now)
          : actionButton(buttons.resume, { agentId: agent.id, action: 'resume' }, deps, reader.now)),
      ],
      [
        // Run's confirm and the picker hold only signed buttons: without a secret they would be dead ends.
        ...(signs ? [tapButton(buttons.schedule, { view: 'schedule', agentId: agent.id })] : []),
        tapButton(buttons.lastRun, { view: 'agentLog', agentId: agent.id }),
      ],
      footer(reader, { view: 'agent', agentId: agent.id }, { text: buttons.backToAgents, view: { view: 'agents' } }),
    ].filter((row) => row.length > 0),
  };
}

function tradeLine(trade: AgentScanSummary['trades'][number], messages: Messages): string | null {
  const text = messages.menu.log;
  if (trade.decision === null || trade.symbol === null || trade.quantity === null) return null;
  const head = text.trade(trade.decision, trade.quantity, trade.symbol);
  if (trade.refused) return head + text.refused(clip(trade.problems.join('; ') || '—'));
  if (trade.proposal === null) return head;
  return head + text.proposalNow(messages.menu.pending.states[trade.proposal.state] ?? trade.proposal.state);
}

async function agentLogScreen(reader: Reader, agent: AgentRow): Promise<Screen> {
  const { messages } = reader;
  const text = messages.menu.log;
  const [row] = await listAgentScans(reader.userId, agent.id, { limit: 1 });
  const lines = [text.title(agent.name)];
  if (row === undefined) {
    lines.push(text.none);
  } else {
    const scan = toScanSummary(row, reader.now);
    lines.push(text.started(clock(new Date(scan.startedAt), reader), text.triggers[scan.trigger]));
    if (scan.finishedAt === null) {
      lines.push(text.running);
    } else if (scan.outcome !== null) {
      lines.push(text.outcome(text.outcomes[scan.outcome] ?? scan.outcome));
    }
    for (const trade of scan.trades) {
      const line = tradeLine(trade, messages);
      if (line !== null) lines.push(line);
    }
    // `scan.error` is the AI service's exception text - SQL, hostnames, a provider's body -
    // and is not copied to Telegram's servers; the outcome says it failed, the app says how.
    lines.push(text.cost(microUsd(scan.costMicroUsd, messages), scan.model));
    lines.push(text.fullOnDecisions);
  }
  lines.push('', messages.menu.asOf(clock(reader.now, reader)));
  return {
    text: lines.join('\n'),
    keyboard: [
      footer(reader, { view: 'agentLog', agentId: agent.id }, { text: messages.menu.buttons.backToAgent, view: { view: 'agent', agentId: agent.id } }),
    ],
  };
}

/** Why a scan would not start, in the reader's words; null when it would. */
export function runRefusal(agent: AgentRow, messages: Messages): string | null {
  if (agent.running_scan !== null) return messages.menu.run.refusals.scan_running;
  const blocked = scanBlocked(agent);
  if (blocked === null) return null;
  return (messages.menu.run.refusals as Record<string, string | undefined>)[blocked.code] ?? messages.menu.run.refusals.other;
}

/** The confirm before a paid scan: what it costs, from which budget, and the signed Run. */
function runConfirmScreen(reader: Reader, agent: AgentRow, deps: MenuDeps): Screen {
  const { messages } = reader;
  const { buttons } = messages.menu;
  const cost = microUsd(scanCostOf(agent).microUsd, messages);
  return {
    text: [
      messages.menu.run.confirm(
        agent.name,
        cost,
        microUsd(Number(agent.llm_spent_today_micro_usd), messages),
        microUsd(Number(agent.llm_budget_micro_usd), messages),
      ),
      '',
      messages.menu.asOf(clock(reader.now, reader)),
    ].join('\n'),
    keyboard: [
      [
        ...actionButton(buttons.confirmRun(cost), { agentId: agent.id, action: 'run' }, deps, reader.now),
        tapButton(buttons.cancel, { view: 'agent', agentId: agent.id }),
      ],
    ],
  };
}

/** The hours a schedule may repeat at, and none: the web's own choices (D195). */
const EVERY_HOURS: (number | null)[] = [
  null,
  ...Array.from({ length: MAX_SCAN_EVERY_HOURS - MIN_SCAN_EVERY_HOURS + 1 }, (_, index) => MIN_SCAN_EVERY_HOURS + index),
];

/** Every button sets a whole schedule: the current one with one thing changed (D277). */
function scheduleScreen(reader: Reader, agent: AgentRow, deps: MenuDeps): Screen {
  const { messages } = reader;
  const { buttons } = messages.menu;
  const current = scheduleOf(agent);
  const set = (schedule: ScanSchedule) => ({ agentId: agent.id, action: 'schedule' as const, schedule });
  const hourButtons = EVERY_HOURS.flatMap((everyHours) => {
    const label = everyHours === null ? buttons.noMarketHours : buttons.everyHours(everyHours);
    const mark = everyHours === current.everyHours ? '• ' : '';
    return actionButton(`${mark}${label}`, set({ ...current, everyHours }), deps, reader.now);
  });
  const slots = slotsOfSchedule(agent);
  return {
    text: [
      messages.menu.schedule.title(agent.name),
      slots.length === 0 ? messages.menu.agent.onlyWhenAsked : messages.menu.agent.schedule(slots.map(messages.scheduledScans.slot)),
      messages.menu.schedule.hint(messages.scheduledScans.slot(slotsOfSchedule({ scan_every_hours: 1, scan_pre_open: false, scan_post_close: false })[0]!)),
      '',
      messages.menu.asOf(clock(reader.now, reader)),
    ].join('\n'),
    keyboard: [
      hourButtons.slice(0, 4),
      hourButtons.slice(4),
      [
        ...actionButton(buttons.preOpen(current.preOpen), set({ ...current, preOpen: !current.preOpen }), deps, reader.now),
        ...actionButton(buttons.postClose(current.postClose), set({ ...current, postClose: !current.postClose }), deps, reader.now),
      ],
      footer(reader, { view: 'schedule', agentId: agent.id }, { text: buttons.backToAgent, view: { view: 'agent', agentId: agent.id } }),
    ].filter((row) => row.length > 0),
  };
}

async function readerFor(userId: string, now: Date): Promise<{ reader: Reader; language: string }> {
  const [settings, user] = await Promise.all([getOrCreateUserSettings(userId), getUser(userId)]);
  return {
    reader: { userId, messages: messagesFor(settings.language), timezone: user?.timezone ?? 'UTC', now },
    language: settings.language,
  };
}

/**
 * One view, read now. An agent that is not the reader's - archived, deleted,
 * the real portfolio, or somebody else's - falls back to the agent list, and
 * `toast` says it is gone. A Run confirm for an agent that cannot scan now
 * falls back to the agent, and `toast` says why.
 */
export async function renderView(
  view: MenuView,
  userId: string,
  deps: MenuDeps,
  now = new Date(),
): Promise<Screen & { toast?: string }> {
  const { reader, language } = await readerFor(userId, now);
  switch (view.view) {
    case 'help':
      return helpScreen(reader, deps.telegram.linkBase);
    case 'portfolio':
      return portfolioScreen(reader, deps.ai);
    case 'status':
      return statusScreen(reader);
    case 'pending':
      return pendingScreen(reader, language);
    case 'agents':
      return agentsScreen(reader);
    case 'agent':
    case 'agentLog':
    case 'runConfirm':
    case 'schedule': {
      const agent = await getAgent(userId, view.agentId);
      if (!visibleAgent(agent)) return { ...(await agentsScreen(reader)), toast: reader.messages.menu.agents.gone };
      switch (view.view) {
        case 'agent':
          return agentScreen(reader, agent, deps);
        case 'agentLog':
          return agentLogScreen(reader, agent);
        case 'schedule':
          return scheduleScreen(reader, agent, deps);
        case 'runConfirm': {
          const refusal = runRefusal(agent, reader.messages);
          return refusal === null
            ? runConfirmScreen(reader, agent, deps)
            : { ...(await agentScreen(reader, agent, deps)), toast: refusal };
        }
      }
    }
  }
}

/** A command's answer: the view as a new message. */
export async function sendView(
  deps: MenuDeps,
  chatId: string,
  userId: string,
  view: MenuView,
  language: string,
): Promise<void> {
  let screen: Screen;
  try {
    screen = await renderView(view, userId, deps);
  } catch (error) {
    // A command is never met with silence: say it could not be read.
    logger().error({ err: error, view: view.view }, 'telegram.menu_view_failed');
    await deps.telegram.sendText(chatId, messagesFor(language).menu.unavailable);
    return;
  }
  const sent = await deps.telegram.sendWithButtons(chatId, screen.text, screen.keyboard);
  if (!sent.delivered) logger().warn({ chatId, view: view.view, err: sent.error }, 'telegram.menu_send_failed');
}

/** Telegram's answer to an edit that would leave the message as it is: a Refresh within the minute. */
const NOT_MODIFIED = /message is not modified/i;

/**
 * A tap on a menu button: apply a quick mute if it is one, then rewrite the
 * message with the view it names. Never throws (`updates.ts`): a view that
 * could not be read is answered with a toast, and the message is left as it was.
 *
 * The caller does not wait for it. A view reads quotes and the market calendar
 * from the AI service, and the poller handles one update at a time, so a slow
 * service would otherwise hold every other user's taps behind this one - as a
 * re-check would (`proposalRecheck.ts`).
 */
export async function handleMenuTap(
  deps: MenuDeps,
  tap: { callbackId: string; chatId: string; messageId: number; userId: string; language: string; data: MenuTap },
): Promise<void> {
  const messages = messagesFor(tap.language);
  let toast = '';
  let view: MenuView;
  try {
    if (tap.data.view === 'mute') {
      const until = tap.data.hours === 0 ? null : new Date(Date.now() + tap.data.hours * 3_600_000);
      await muteUntil(tap.userId, until);
      toast = until === null ? messages.menu.status.unmutedToast : messages.menu.status.mutedToast(tap.data.hours);
      view = { view: 'status' };
    } else {
      view = tap.data;
    }
    const screen = await renderView(view, tap.userId, deps);
    if (screen.toast !== undefined) toast = screen.toast;
    // The edit first, so the toast can say when it failed; Telegram keeps the
    // button's spinner until the answer, which is the "working" sign.
    const edited = await deps.telegram.editWithButtons(tap.chatId, tap.messageId, screen.text, screen.keyboard);
    if (!edited.delivered && NOT_MODIFIED.test(edited.error ?? '')) {
      // A Refresh within the same minute: nothing changed, nothing lost.
      logger().info({ chatId: tap.chatId, view: view.view }, 'telegram.menu_edit_unchanged');
    } else if (!edited.delivered) {
      logger().warn({ chatId: tap.chatId, view: view.view, err: edited.error }, 'telegram.menu_edit_failed');
      if (toast === '') toast = messages.menu.unavailable;
    }
    await deps.telegram.answerCallback(tap.callbackId, toast);
  } catch (error) {
    logger().error({ err: error, view: tap.data.view }, 'telegram.menu_view_failed');
    // A mute that was applied is said, even when the view after it could not be read.
    await deps.telegram.answerCallback(tap.callbackId, toast === '' ? messages.menu.unavailable : toast);
  }
}
