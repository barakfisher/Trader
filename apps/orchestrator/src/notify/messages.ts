/**
 * Every fixed sentence the orchestrator says to a user, in each interface
 * language: Telegram's replies, buttons and outcome lines, the narration
 * notices, and the digest's own wording (decision 99 in `.claude/MEMORY.md`).
 *
 * **A typed record, not i18next.** The web keeps its catalogue in JSON because
 * it has seven hundred keys and a parity test; this has a few dozen, several of
 * them functions of a count or a duration. `Record<UiLanguage, Messages>` makes
 * a missing sentence a compile error - the web's rule, enforced by the compiler
 * instead of a test - and a Hebrew plural is just a function that knows it.
 *
 * **What is not here.** An observation's own headline and explanation are not
 * composed in the orchestrator at all: they arrive written, in English and in
 * `observations.localized`, from the AI service's templates. This module only
 * frames them - with one exception, `moveWithDrawdown` (decision 148), which says
 * a holding's move and drawdown in one sentence from their stored evidence.
 *
 * Figures and Latin-script fragments in the Hebrew are wrapped in isolates, as
 * the AI service's Hebrew templates are (`hebrew_templates.py`): a left-to-right
 * isolate for a figure, a first-strong isolate for text the user wrote (a topic
 * label can be in either script). Telegram renders plain text, so markup cannot
 * do this job there; the isolates are invisible.
 */

import {
  RECHECK_WINDOW_DAYS,
  type AgentScanOutcome,
  type AssistantOutcome,
  type DigestReason,
  type EvidenceChecked,
  type LocalizedTexts,
  type RecheckCheck,
  type RecheckUnanswered,
  type ScanToolName,
  type TopicSentimentGap,
  type TranslatedLanguage,
  type UiLanguage,
} from '@traders/shared';

import type { CallbackAction } from '../telegram/callbackToken.js';
import type { BotCommand } from '../telegram/commandMenu.js';
import type { FailureCause } from '../services/scheduledScans.js';
import { slotClock, type ScanSlot } from '../services/scanSchedule.js';
import type { NarrationState } from '../services/narrationHealth.js';
import type { RefusalReason } from '../services/proposalState.js';
import type { MarketBenchmarkSymbol } from '../services/marketBenchmarks.js';

/** LEFT-TO-RIGHT ISOLATE ... POP: a figure, kept left to right in a Hebrew line. */
export function ltr(text: string | number): string {
  return `\u2066${text}\u2069`;
}

/** FIRST-STRONG ISOLATE ... POP: text whose direction is its own, such as a label. */
export function isolated(text: string): string {
  return `\u2068${text}\u2069`;
}

/** Why a re-check could not start, by the AI service's code (D212); `other` for the rest. */
export type RecheckRefusal =
  | 'not_expired'
  | 'recheck_window_passed'
  | 'already_rechecked'
  | 'superseded'
  | 'budget_spent'
  | 'scan_running'
  | 'agent_not_active'
  | 'no_persona'
  | 'other';

/** Why *Run a scan now* would not start, by the code `services/manualScan.ts` throws; `other` for the rest. */
export type RunRefusal =
  | 'agent_not_active'
  | 'no_persona'
  | 'scan_running'
  | 'budget_spent'
  | 'no_model'
  | 'other';

/** A refused trade approval's code, as `fills.ts` and `tradeApproval.ts` throw it. */
export type TradeRefusalCode =
  | 'quote_too_old'
  | 'quote_unavailable'
  | 'price_moved'
  | 'insufficient_cash'
  | 'insufficient_holding'
  | 'not_tradable'
  | 'agent_archived'
  | 'other';

export interface TradePreviewFigures {
  side: 'buy' | 'sell';
  quantity: string;
  symbol: string;
  livePrice: string;
  agentPrice: string;
  /** Signed, e.g. "+0.25%". */
  distance: string;
  notional: string;
  fee: string;
  cashAfter: string;
  /** D3's band around the live price, e.g. "0.5%". */
  band: string;
}

export interface TradeFillFigures {
  side: 'buy' | 'sell';
  quantity: string;
  symbol: string;
  price: string;
  fee: string;
  cash: string;
  at: string;
}

/**
 * A move and a drawdown on one holding, found by one scan (decision 148). Every
 * figure arrives formatted in this language's locale; the percentages are
 * magnitudes, and `direction` carries the sign.
 */
export interface MoveWithDrawdownFigures {
  symbol: string;
  direction: 'fell' | 'rose';
  change: string;
  price: string;
  drawdown: string;
  high: string;
  /** The drawdown window, or null when the evidence does not say. */
  windowDays: number | null;
  /** The move in standard deviations, present only for an unusual (sigma) move. */
  sigma: string | null;
}

/** Decision 149: what the market did the day a holding moved. Figures are pre-formatted. */
export interface MarketLineFigures {
  benchmark: MarketBenchmarkSymbol;
  direction: 'fell' | 'rose';
  change: string;
}

export type RecordedNarrationState = Exclude<NarrationState, 'unknown'>;

export interface NoticeText {
  headline: string;
  explanation: string;
}

export interface Messages {
  /** The `Intl` locale for times written into a message. */
  locale: string;
  /** The `Intl` locale for numbers and money, as the web's `i18n/format.ts` has it. */
  numberLocale: string;

  buttons: Record<'approve' | 'reject' | 'snooze' | 'confirm', string>;
  undoButton: string;
  working: Record<CallbackAction, string>;
  openInApp: string;

  /** The toast after a tap, by the state the proposal is now in. */
  decisionReplies: Partial<Record<string, string>>;
  snoozedFor: (hours: number) => string;
  refusalReplies: Partial<Record<RefusalReason, string>>;
  undoTooLate: (seconds: number) => string;
  /** Appended to the alert once a decision is in: the record, not the toast. */
  outcomeLines: Partial<Record<string, string>>;
  nowState: (state: string) => string;
  proposalGone: string;
  /** A question or a re-check refused by its rate limit (D257), with when to retry. */
  rateLimited: (minutes: number) => string;
  cannotChange: string;
  stillWorking: string;
  buttonUnusable: string;
  buttonInvalid: string;

  nothingPending: string;
  muteUsage: string;
  mutedUntil: (until: string) => string;
  disconnected: string;
  /** Severity names, for a sentence: `notify_severity` is stored in English. */
  severities: Record<string, string>;
  unmuted: string;
  connected: string;
  chatTaken: string;
  linkUsed: string;
  linkInvalid: string;
  /** `/start` in a group (D273): connect in a one-to-one chat. */
  privateChatOnly: string;

  /**
   * The bot's menu (M11 slice A1, D269-D272): `/help`, the views its buttons
   * open, and the descriptions in Telegram's command list. Every figure arrives
   * formatted in this language's locale; these only frame them.
   */
  menu: {
    /** Shown beside each command when the user types `/` (`commandMenu.ts`). */
    commands: Record<BotCommand, string>;
    help: string;
    buttons: {
      portfolio: string;
      agents: string;
      status: string;
      pending: string;
      refresh: string;
      menu: string;
      lastRun: string;
      backToAgents: string;
      backToAgent: string;
      mute: (hours: number) => string;
      unmute: string;
      runScan: string;
      pause: string;
      resume: string;
      schedule: string;
      cancel: string;
      confirmRun: (cost: string) => string;
      everyHours: (hours: number) => string;
      noMarketHours: string;
      preOpen: (on: boolean) => string;
      postClose: (on: boolean) => string;
    };
    asOf: (time: string) => string;
    /** A view that could not be read: the toast, and the message is left as it was. */
    unavailable: string;
    portfolio: {
      title: string;
      empty: string;
      value: (value: string) => string;
      today: (change: string, percent: string) => string;
      todayUnknown: string;
      holdings: (count: number, priced: number) => string;
      /** The total leaves these out: never valued at zero (guideline 7). */
      unpriced: (symbols: string[]) => string;
      stale: string;
      agentsApart: string;
    };
    status: {
      title: string;
      alertingFrom: (severity: string) => string;
      mutedUntil: (until: string) => string;
      notMuted: string;
      quietHours: (start: string, end: string) => string;
      mutedToast: (hours: number) => string;
      unmutedToast: string;
    };
    pending: {
      title: string;
      /** Proposal states, for a sentence: stored in English. */
      states: Record<string, string>;
    };
    agents: {
      title: string;
      empty: string;
      choose: string;
      gone: string;
      scansADay: (count: number) => string;
    };
    agent: {
      states: Record<'active' | 'paused', string>;
      running: (since: string) => string;
      schedule: (slots: string[]) => string;
      onlyWhenAsked: string;
      nextScan: (at: string) => string;
      /** The market calendar could not be read just now. */
      nextScanUnknown: string;
      /** This installation does not run scheduled scans (D71). */
      notScheduledHere: string;
      waitingForBrief: string;
      cash: (cash: string, deposited: string) => string;
      netWorth: (worth: string, pnl: string, percent: string) => string;
      unpriced: (symbols: string[]) => string;
      holdings: (count: number) => string;
      spentToday: (spent: string, budget: string) => string;
    };
    log: {
      title: (agent: string) => string;
      none: string;
      started: (at: string, trigger: string) => string;
      triggers: Record<'manual' | 'schedule' | 'refresh', string>;
      running: string;
      outcome: (outcome: string) => string;
      outcomes: Record<AgentScanOutcome, string>;
      trade: (side: 'buy' | 'sell', quantity: string, symbol: string) => string;
      proposalNow: (state: string) => string;
      refused: (problems: string) => string;
      cost: (cost: string, model: string | null) => string;
      fullOnDecisions: string;
    };
    /** *Run a scan now* (M11 A2): the confirm, the wait, and why it would not start. */
    run: {
      confirm: (agent: string, cost: string, spent: string, budget: string) => string;
      startedToast: string;
      running: (agent: string) => string;
      refusals: Record<RunRefusal, string>;
      /** Above the agent's view when a started scan could not finish. */
      failed: (reason: string) => string;
    };
    /** Pause, Resume and a new schedule (M11 A2). */
    control: {
      pausedToast: string;
      resumedToast: string;
      scheduleSavedToast: string;
      limitReached: (max: number) => string;
      /** A signed agent button past its time: the view is drawn again with fresh ones. */
      expired: string;
      refused: string;
    };
    schedule: {
      title: (agent: string) => string;
      /** `first` is the first market-hours slot as `scheduledScans.slot` names it. */
      hint: (first: string) => string;
    };
  };

  /** A trade proposal's headline (D51: the frame is the catalogue's; the thesis the model's). */
  tradeProposalHeadline: (agent: string, side: 'buy' | 'sell', quantity: string, symbol: string, price: string) => string;
  /** D197: appended to a buy's headline when it needs the proceeds of sells from the same scan. */
  tradeFundedBy: (symbols: string[]) => string;

  /** Decision 148: a holding's move and drawdown from one scan, said in one message. */
  moveWithDrawdown: (figures: MoveWithDrawdownFigures) => NoticeText;

  /**
   * Decision 149: one line under a move, when the holding's best-fitting index
   * moved the same way that day. A fact beside the move, never a cause of it.
   */
  marketLine: (figures: MarketLineFigures) => string;

  /**
   * The "Evidence checked" line under a trade proposal: the tools the agent's
   * scan called and what it asked them, from its transcript. A tool is named by
   * this catalogue, never by its code name.
   */
  evidenceChecked: (checked: EvidenceChecked) => string;

  /**
   * Approving a trade in Telegram (D47, D49, D60-D63): the preview *Approve*
   * answers with, the fill *Confirm* writes, and a refusal. Every figure arrives
   * already formatted in this language's locale; these only frame them.
   */
  trade: {
    previewToast: string;
    preview: (figures: TradePreviewFigures) => string;
    filledToast: string;
    filled: (figures: TradeFillFigures) => string;
    /** A refusal's outcome line under the message; the toast is the reason alone. */
    refused: (reason: string, at: string) => string;
    reasons: Record<TradeRefusalCode, string>;
    marketClosed: (nextOpen: string) => string;
    farFromAgent: (agentPrice: string, livePrice: string, distance: string) => string;
    /** A price too large for a signed button (`MAX_CALLBACK_PRICE_MINOR`). */
    confirmInApp: string;
  };

  /**
   * Re-checking an expired trade proposal (D212-D217): the button, the toast,
   * and the line its outcome adds under the message. The agent's own reason
   * arrives written in this language (D51); everything around it is here.
   */
  recheck: {
    button: string;
    startedToast: string;
    proposed: (at: string) => string;
    declined: (at: string, reason: string) => string;
    unanswered: (at: string, cause: string) => string;
    agentSaid: (thesis: string) => string;
    checks: Record<RecheckCheck, string>;
    causes: Record<RecheckUnanswered, string>;
    refusals: Record<RecheckRefusal, string>;
  };

  /**
   * A question to the assistant from the chat (D221-D224). The answer and a
   * decline are the model's, in the question's language (D220); these are the
   * fixed sentences around them, chosen by the question's language too (D224).
   */
  ask: {
    /** Said instead of an answer, by the outcome that left none. */
    noReply: Record<Exclude<AssistantOutcome, 'answer' | 'decline' | 'clarify'>, string>;
    tooLong: (limit: number) => string;
    stillAnswering: string;
    unavailable: string;
    textOnly: string;
    /** The heading over the news an answer drew on. */
    sources: string;
    newConversation: string;
  };

  /**
   * A sign-up request, said to the admin (D156, D184, D187). Figures - the cap,
   * the time - arrive formatted in this language's locale; the email and zone
   * are the requester's own text.
   */
  signup: {
    request: (email: string, timezone: string) => string;
    buttons: {
      approveDefault: (cap: string) => string;
      reject: string;
      custom: string;
      amount: (cap: string) => string;
      otherAmount: string;
    };
    /** Under the preset amounts when there is no link to the Admin page to show. */
    otherAmountInApp: string;
    approvedToast: string;
    rejectedToast: string;
    chooseAmountToast: string;
    /** The outcome lines under the message; approval reminds the admin to tell them. */
    approvedLine: (cap: string, at: string) => string;
    rejectedLine: (at: string) => string;
    /** A tap on a request that had already moved on - decided on the page, say. */
    already: Record<'pending' | 'active' | 'rejected' | 'disabled' | 'gone', string>;
  };

  /** D74: a scheduled slot that gave up, said once. */
  scheduledScans: {
    /** A slot by name: before the open, after the close, or its New York time (D195). */
    slot: (slot: ScanSlot) => string;
    causes: Record<FailureCause, string>;
    gaveUp: (agent: string, slot: string, day: string, cause: string) => NoticeText;
  };

  narration: Record<RecordedNarrationState, NoticeText>;
  /** A state added to `NarrationState` without words here still says something true. */
  narrationFallback: NoticeText;

  digest: {
    title: (findings: number, topics: number, narrationChanged: boolean) => string;
    reasons: Record<DigestReason, string>;
    reasonLine: (count: number, reason: string) => string;
    topicsHeading: string;
    noUnusualMove: (label: string) => string;
    notMeasured: (label: string, reason: string) => string;
    notScanned: (label: string) => string;
    news: (days: number, gap: TopicSentimentGap | null, articles: number, tone: string, model: string) => string;
  };
}

/** English: the source, and what a chat with no known user is answered in. */
/** Each benchmark's name in a sentence; a benchmark without one is a compile error. */
const EN_BENCHMARKS: Record<MarketBenchmarkSymbol, string> = {
  SPY: 'the S&P 500',
  QQQ: 'the Nasdaq-100',
  IWM: 'the Russell 2000',
  'BTC-USD': 'Bitcoin',
};

const EN_TOOLS: Record<ScanToolName, string> = {
  search_universe: 'universe search',
  get_quote: 'quote',
  get_price_history: 'price history',
  get_findings: 'findings',
  get_news: 'news',
  get_position: 'position',
  explain_concept: 'glossary',
};

/** A search phrase is quoted; a symbol is not. */
const QUOTED_TOOLS: ReadonlySet<ScanToolName> = new Set(['search_universe', 'explain_concept']);

function enCheck({ tool, subject, days }: EvidenceChecked['checks'][number]): string {
  const parts = [EN_TOOLS[tool]];
  if (subject !== null) parts.push(QUOTED_TOOLS.has(tool) ? `“${subject}”` : subject);
  if (days !== null && tool === 'get_price_history') parts.push(`(${days} trading ${days === 1 ? 'day' : 'days'})`);
  if (days !== null && tool === 'get_news') parts.push(`(${days} ${days === 1 ? 'day' : 'days'})`);
  return parts.join(' ');
}

const en: Messages = {
  locale: 'en-GB',
  numberLocale: 'en-US',

  buttons: { approve: 'Approve', reject: 'Reject', snooze: 'Snooze', confirm: 'Confirm' },
  undoButton: '↩ Undo approval',
  working: {
    approve: '⏳ Approving…',
    reject: '⏳ Rejecting…',
    snooze: '⏳ Snoozing…',
    undo: '⏳ Undoing…',
    confirm: '⏳ Filling…',
    recheck: '⏳ Re-checking…',
  },
  openInApp: 'Open in app',

  decisionReplies: {
    approved: 'Approved ✓ — recorded in your ledger. No order was placed.',
    pending: 'Approval undone ✓ — the question is open again.',
    rejected: 'Rejected ✓',
    expired: 'This has expired — open the app for the refreshed view.',
  },
  snoozedFor: (hours) => `Snoozed for ${hours}h`,
  refusalReplies: {
    not_undoable: 'Only an approval can be undone.',
    already_decided: 'This was already decided — open the app to see how.',
    not_for_trades: 'A trade can only be approved or rejected.',
  },
  undoTooLate: (seconds) => `Too late to undo — approvals can be undone for ${seconds} seconds.`,
  outcomeLines: {
    approved: '✅ Approved — recorded in your ledger. No order was placed.',
    rejected: '❌ Rejected',
    snoozed: '⏸ Snoozed — still open; decide any time before it expires',
    expired: '⏳ Expired — no longer answerable',
    pending: '↩ Approval undone — open again; nothing remains in your ledger',
  },
  nowState: (state) => `Now ${state}.`,
  proposalGone: 'That proposal no longer exists.',
  rateLimited: (minutes) =>
    `Too many requests in a short time. Try again in ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.`,
  cannotChange: 'That can no longer be changed.',
  stillWorking: 'Still working on it…',
  buttonUnusable: 'This button is no longer usable.',
  buttonInvalid: 'This button is not valid for this chat.',

  nothingPending: 'Nothing waiting on you.',
  muteUsage: 'Try /mute 2h or /mute 30m.',
  mutedUntil: (until) => `Muted until ${until}. Findings still reach your feed and the digest.`,
  disconnected: 'Disconnected. Your portfolio is still being watched; nothing will be sent here.',
  severities: { info: 'info', notable: 'notable', high: 'high' },
  unmuted: 'Alerts are on again.',
  connected: 'Connected. Alerts will arrive here. /help shows what this bot can do.',
  chatTaken: 'This chat is already connected to another account.',
  linkUsed: 'That link has already been used. Generate a new one.',
  linkInvalid: 'That link is not valid or has expired. Generate a new one.',
  privateChatOnly:
    'This bot works only in a private chat: in a group, every member would see your portfolio. Open the link from Settings again and connect in a chat with the bot itself.',

  menu: {
    commands: {
      help: 'What this bot can do',
      portfolio: "Your real portfolio: value and today's change",
      agents: 'Your simulated agents: run, pause, schedule, last scan',
      pending: 'Proposals waiting on you',
      status: 'Alerts and mute',
      mute: 'Pause alerts: /mute 2h or /mute 30m',
      unmute: 'Turn alerts back on',
      new: 'Start a new conversation with the assistant',
      stop: 'Disconnect this chat',
    },
    help: [
      '🧭 Traders',
      'Write any question and the assistant answers it.',
      '',
      "/portfolio - your real portfolio: value and today's change",
      '/agents - your simulated agents: run a scan, pause, change the schedule, see the last run',
      '/pending - proposals waiting on you',
      '/status - alerts and mute',
      '/mute 2h · /unmute - pause or resume alerts',
      '/new - a new conversation with the assistant',
      '/stop - disconnect this chat',
      '',
      'Nothing here places an order: approvals write to the virtual ledger only.',
    ].join('\n'),
    buttons: {
      portfolio: '📊 Portfolio',
      agents: '🤖 Agents',
      status: '🔔 Status / Mute',
      pending: '⏳ Pending',
      refresh: '🔄 Refresh',
      menu: '⬅️ Menu',
      lastRun: '📜 Last run',
      backToAgents: '⬅️ Agents',
      backToAgent: '⬅️ Agent',
      mute: (hours) => `🔕 Mute ${hours}h`,
      unmute: '🔔 Unmute',
      runScan: '▶️ Run scan now',
      pause: '⏸ Pause',
      resume: '▶️ Resume',
      schedule: '⏱ Schedule',
      cancel: '✖️ Cancel',
      confirmRun: (cost) => `✅ Run (about ${cost})`,
      everyHours: (hours) => `${hours}h`,
      noMarketHours: 'None',
      preOpen: (on) => `${on ? '✅' : '⬜'} Pre-open`,
      postClose: (on) => `${on ? '✅' : '⬜'} After close`,
    },
    asOf: (time) => `As of ${time}`,
    unavailable: 'Could not load this right now. Try again in a minute.',
    portfolio: {
      title: '📊 Your portfolio',
      empty: 'No holdings yet. Add them in the app.',
      value: (value) => `Value: ${value}`,
      today: (change, percent) => `Today: ${change} (${percent})`,
      todayUnknown: "Today: not known - no previous close to compare with",
      holdings: (count, priced) =>
        count === priced
          ? `${count} ${count === 1 ? 'holding' : 'holdings'}, all priced`
          : `${count} ${count === 1 ? 'holding' : 'holdings'}, ${priced} priced`,
      unpriced: (symbols) => `⚠️ No price for ${symbols.join(', ')}: left out of the value, not counted as zero.`,
      stale: 'Some prices are delayed or from the last close.',
      agentsApart: 'Simulated agents are not included: see /agents.',
    },
    status: {
      title: '🔔 Alerts',
      alertingFrom: (severity) => `Alerting on ${severity} and above.`,
      mutedUntil: (until) => `🔕 Muted until ${until}.`,
      notMuted: 'Not muted.',
      quietHours: (start, end) => `Quiet hours ${start}-${end}.`,
      mutedToast: (hours) => `Muted for ${hours}h`,
      unmutedToast: 'Alerts are on',
    },
    pending: {
      title: '⏳ Waiting on you',
      states: { pending: 'pending', snoozed: 'snoozed', approved: 'approved', rejected: 'rejected', expired: 'expired' },
    },
    agents: {
      title: '🤖 Your agents',
      empty: 'No simulated agents yet. Create one in the app.',
      choose: 'Choose one to see its schedule and last scan.',
      gone: 'That agent no longer exists.',
      scansADay: (count) => (count === 0 ? 'on request' : `${count} ${count === 1 ? 'scan' : 'scans'}/day`),
    },
    agent: {
      states: { active: 'Active', paused: 'Paused' },
      running: (since) => `🔄 Scanning now (since ${since})`,
      schedule: (slots) => `Schedule: ${slots.join(' · ')}, trading days`,
      onlyWhenAsked: 'Schedule: none - scans only when you ask',
      nextScan: (at) => `Next scan: ${at}`,
      nextScanUnknown: 'Next scan: not known right now (the market calendar could not be read)',
      notScheduledHere: 'Scheduled scans are off on this installation.',
      waitingForBrief: 'Waiting for instructions or settings: it does not scan until it has them.',
      cash: (cash, deposited) => `Cash: ${cash} of ${deposited} deposited`,
      netWorth: (worth, pnl, percent) => `Net worth: ${worth} (P&L ${pnl}, ${percent})`,
      unpriced: (symbols) => `⚠️ No price for ${symbols.join(', ')}: net worth not known.`,
      holdings: (count) => `${count} ${count === 1 ? 'holding' : 'holdings'}`,
      spentToday: (spent, budget) => `AI spend today: ${spent} of ${budget}`,
    },
    log: {
      title: (agent) => `📜 ${agent}: last scan`,
      none: 'No scans yet.',
      started: (at, trigger) => `${at}, ${trigger}`,
      triggers: { manual: 'run by you', schedule: 'scheduled', refresh: 're-check' },
      running: 'Still running.',
      outcome: (outcome) => `Outcome: ${outcome}`,
      outcomes: {
        trade: 'proposed trades',
        no_trade: 'no trade',
        invalid_answer: 'the answer could not be read',
        budget_reached: "the agent's daily AI budget ran out",
        step_limit: 'stopped at its step limit',
        failed: 'failed',
        rule_rejected: 'refused by the checks',
        cap_reached: 'your monthly AI limit was reached',
        own_key_failed: 'your own OpenRouter key was refused',
      },
      trade: (side, quantity, symbol) => `• ${side === 'buy' ? 'Buy' : 'Sell'} ${quantity} ${symbol}`,
      proposalNow: (state) => ` - ${state}`,
      refused: (problems) => ` - not proposed: ${problems}`,
      cost: (cost, model) => (model === null ? `Cost ${cost}` : `Cost ${cost} (${model})`),
      fullOnDecisions: "The full transcript is on the agent's Decisions tab.",
    },
    run: {
      confirm: (agent, cost, spent, budget) =>
        [
          `▶️ Run a scan of ${agent} now?`,
          `It costs about ${cost}, from the agent's AI budget (${spent} of ${budget} spent today).`,
          'Anything it proposes comes here for your approval. Nothing is ever bought or sold for real.',
        ].join('\n'),
      startedToast: 'Scanning - the result appears here.',
      running: (agent) => `🔄 ${agent} is scanning. The result appears here in about a minute.`,
      refusals: {
        agent_not_active: 'The agent is paused: resume it to scan.',
        no_persona: 'The agent has no instructions or settings to decide by.',
        scan_running: 'The agent is scanning right now.',
        budget_spent: "The agent's AI budget for today is spent.",
        no_model: 'No model is chosen for agents (Admin page).',
        other: 'The scan could not run.',
      },
      failed: (reason) => `⚠️ The scan did not finish: ${reason}`,
    },
    control: {
      pausedToast: 'Paused - no scheduled scans until you resume it.',
      resumedToast: 'Resumed.',
      scheduleSavedToast: 'Schedule saved.',
      limitReached: (max) => `You already have ${max} active agents, the most allowed: pause one first.`,
      expired: 'That button had expired - here is the current view.',
      refused: 'That could not be changed.',
    },
    schedule: {
      title: (agent) => `⏱ ${agent}: when it scans`,
      hint: (first) => `Market-hours scans start at ${first} and repeat at the chosen interval until the close; trading days only.`,
    },
  },

  tradeProposalHeadline: (agent, side, quantity, symbol, price) =>
    `${agent} proposes to ${side} ${quantity} ${symbol} at ${price}`,
  tradeFundedBy: (symbols) => ` - paid for by selling ${symbols.join(', ')}: approve that first`,

  moveWithDrawdown: (f) => ({
    headline: `${f.symbol} ${f.direction} ${f.change} to ${f.price}`,
    explanation:
      `Now ${f.drawdown} below its ${f.windowDays === null ? 'recent' : `${f.windowDays}-day`} high of ${f.high}` +
      (f.sigma === null ? '.' : `; the move was ${f.sigma} standard deviations from its recent average.`),
  }),

  marketLine: (f) =>
    `Same day, ${EN_BENCHMARKS[f.benchmark]} (${f.benchmark}) ${f.direction} ${f.change}.`,

  evidenceChecked: ({ checks, otherCalls }) => {
    const parts = checks.map(enCheck);
    if (otherCalls > 0) parts.push(otherCalls === 1 ? '1 other tool' : `${otherCalls} other tools`);
    return parts.length === 0
      ? 'Checked: nothing - the agent decided from its briefing alone.'
      : `Checked: ${parts.join(' · ')}`;
  },

  trade: {
    previewToast: 'Check the live price, then Confirm.',
    preview: (f) =>
      [
        `At the live price: ${f.side} ${f.quantity} ${f.symbol} at ${f.livePrice}`,
        `The agent's price ${f.agentPrice} (${f.distance})`,
        `Cost ${f.notional}, fee ${f.fee}; cash after ${f.cashAfter}`,
        `Confirm fills within ${f.band} of ${f.livePrice}. Virtual ledger only - no order is placed.`,
      ].join('\n'),
    filledToast: 'Filled ✓ — recorded in the virtual ledger. No order was placed.',
    filled: (f) =>
      `✅ ${f.side === 'buy' ? 'Bought' : 'Sold'} ${f.quantity} ${f.symbol} at ${f.price}, fee ${f.fee}; cash ${f.cash} (${f.at}). Virtual ledger - no order was placed.`,
    refused: (reason, at) => `⚠️ Not approved (${at}): ${reason} Still open until it expires.`,
    reasons: {
      quote_too_old: 'The latest price is too old to trade at.',
      quote_unavailable: 'No price is available right now.',
      price_moved: 'The price moved more than 0.5% since the preview. Approve again for the new price.',
      insufficient_cash: 'The agent does not have the cash for this trade and its fee.',
      insufficient_holding: 'The agent no longer holds enough shares.',
      not_tradable: 'This instrument cannot be traded.',
      agent_archived: 'The agent is archived.',
      other: 'The trade was refused.',
    },
    marketClosed: (nextOpen) => `The market is closed; it opens ${nextOpen}.`,
    farFromAgent: (agentPrice, livePrice, distance) =>
      `The price is ${livePrice}, ${distance} from the agent's ${agentPrice} - more than 3%.`,
    confirmInApp: 'This price is too large for a Telegram button: confirm it in the app.',
  },

  ask: {
    noReply: {
      failed: "No answer I could check against the data, so none is shown. Try asking again, or more narrowly.",
      budget_reached: "Today's spending limit for questions is reached. Questions work again after midnight.",
      cap_reached: "This month's spending limit for your account is reached. Questions work again when the next month begins.",
      no_model: 'The assistant needs a model, and none is set up. An admin can choose one on the Admin page.',
      own_key_failed:
        "OpenRouter refused your own API key, so this question wasn't answered. Settings says why; until you save a working key, questions use this installation's account under your monthly limit.",
    },
    tooLong: (limit) => `That question is too long. Ask it in at most ${limit} characters.`,
    stillAnswering: 'Still answering your last question. Send this one again when that answer arrives.',
    unavailable: "The assistant couldn't be reached, so this question wasn't answered. Try again in a minute.",
    textOnly: 'I can read text only. Write your question as a message.',
    sources: 'Sources:',
    newConversation: 'New conversation. Your next question starts it.',
  },
  recheck: {
    button: '🔄 Re-check',
    startedToast: "Re-checking at today's price - the answer follows here.",
    proposed: (at) => `🔄 Re-checked (${at}): a new proposal follows.`,
    declined: (at, reason) => `🔄 Re-checked (${at}): no new proposal. ${reason}`,
    unanswered: (at, cause) => `🔄 The re-check did not finish (${at}): ${cause} You can try again.`,
    agentSaid: (thesis) => `The agent: ${thesis}`,
    checks: {
      malformed: "The agent's answer could not be read.",
      decision_limit: 'The agent answered with more than one trade.',
      duplicate: 'The agent named the same trade twice.',
      already_waiting: 'The same trade is already waiting for your approval.',
      not_tradable: 'This instrument can no longer be traded here.',
      holding: 'The agent no longer holds enough shares to sell.',
      thesis: "The agent's reasoning was too long to show.",
      figures: "The agent's reasoning cited figures the evidence does not contain.",
      no_price: 'No price is available right now.',
      too_small: 'The sale would bring in less than its fee.',
      cash: 'The agent does not have the cash for it and its fee.',
      mandate: "The trade no longer fits the agent's settings.",
      not_this_trade: 'The agent proposed a different trade, which a re-check cannot do.',
      no_answer: 'The agent gave no answer the server could check.',
    },
    causes: {
      failed: 'it failed.',
      budget_reached: "the agent's daily AI budget ran out.",
      cap_reached: 'your monthly AI limit is reached.',
      own_key_failed: 'your own OpenRouter key stopped working.',
    },
    refusals: {
      not_expired: 'Only an expired proposal can be re-checked.',
      recheck_window_passed: `It expired more than ${RECHECK_WINDOW_DAYS} days ago.`,
      already_rechecked: 'This proposal has already been re-checked.',
      superseded: 'A later proposal for the same trade was approved, so there is nothing to re-check.',
      budget_spent: "The agent's AI budget for today is spent.",
      scan_running: 'The agent is scanning right now - try again in a minute.',
      agent_not_active: 'The agent is paused or archived.',
      no_persona: 'The agent has no instructions or settings to decide by.',
      other: 'The re-check could not run.',
    },
  },

  signup: {
    request: (email, timezone) =>
      `New sign-up request\n\n${email}\nTime zone: ${timezone}\n\nApprove to let them in with a monthly AI spending cap.`,
    buttons: {
      approveDefault: (cap) => `Approve, ${cap}/month`,
      reject: 'Reject',
      custom: 'Custom budget',
      amount: (cap) => `${cap}/month`,
      otherAmount: 'Other amount',
    },
    otherAmountInApp: 'For another amount, approve on the Admin page.',
    approvedToast: 'Approved.',
    rejectedToast: 'Rejected.',
    chooseAmountToast: 'Choose a monthly cap.',
    approvedLine: (cap, at) => `✅ Approved with ${cap}/month (${at}). Let them know they can sign in.`,
    rejectedLine: (at) => `❌ Rejected (${at}).`,
    already: {
      pending: 'This request is still waiting.',
      active: 'Already approved.',
      rejected: 'Already rejected.',
      disabled: 'This account has been disabled.',
      gone: 'This request no longer exists.',
    },
  },

  scheduledScans: {
    slot: (slot) =>
      slot === 'pre_open' ? 'pre-open' : slot === 'post_close' ? 'post-close' : `${slotClock(slot)} New York`,
    causes: {
      rate_limited: 'the model provider is rate-limiting requests',
      provider_error: 'the model provider or the AI service returned an error',
      timeout: 'the scan did not finish in time',
      agent_busy: 'the agent was still busy with another scan',
      no_model: 'no model is chosen for agents (Admin page)',
      scan_failed: 'the model call failed during the scan',
      window_closed: 'its time window ended before it could run again',
    },
    gaveUp: (agent, slot, day, cause) => ({
      headline: `⚠️ ${agent}'s ${slot} scan (${day}) did not run`,
      explanation: `It stopped trying because ${cause}. Nothing was proposed; the next scheduled scan runs as usual. Details are on the agent's Decisions tab.`,
    }),
  },

  narration: {
    narrating: {
      headline: 'Explanations are written by the model again',
      explanation:
        'New findings are explained in their own terms again, and every figure is still checked against the evidence before it is stored.',
    },
    off: {
      headline: 'Explanations are written by templates: no model is configured',
      explanation:
        'Every figure is still checked and still correct; the phrasing is fixed. This is a configuration, not a fault.',
    },
    rejected: {
      headline: 'Explanations fell back to templates: the model output was refused',
      explanation:
        'The model is answering, and its sentences contain figures that are not in the evidence, so templates are used instead and nothing wrong reached you. A more capable model is the fix; waiting is not.',
    },
    exhausted: {
      headline: 'Explanations fell back to templates: the spend ceiling was reached',
      explanation:
        'The model calls were stopped by the budget. Templates are used until the ceiling resets or is raised.',
    },
    unavailable: {
      headline: 'Explanations fell back to templates: the model is unavailable',
      explanation:
        'The provider refused or failed the recent requests. Templates are used meanwhile; this often clears by itself.',
    },
  },
  narrationFallback: {
    headline: 'Explanations changed how they are written',
    explanation: 'Every figure in them is still checked against the evidence before it is shown.',
  },

  digest: {
    title: (findings, topics, narrationChanged) => {
      const parts: string[] = [];
      if (findings > 0) parts.push(`${findings} finding${findings === 1 ? '' : 's'}`);
      if (topics > 0) parts.push(`${topics} topic${topics === 1 ? '' : 's'}`);
      if (narrationChanged) parts.push('explanations changed');
      return `Daily digest: ${parts.join(', ')}`;
    },
    reasons: {
      below_floor: 'below your alert threshold',
      quiet_hours: 'held during quiet hours',
      muted: 'held while muted',
      above_floor: 'not delivered when first found',
    },
    reasonLine: (count, reason) => `${count} ${reason}`,
    topicsHeading: 'Topics',
    noUnusualMove: (label) => `${label}: no unusual move in the last day`,
    notMeasured: (label, reason) => `${label}: not measured (${reason})`,
    notScanned: (label) => `${label}: not scanned yet`,
    news: (days, gap, articles, tone, model) => {
      const prefix = `News, last ${days} days:`;
      const counted = `${articles} article${articles === 1 ? '' : 's'}`;
      switch (gap) {
        case 'no_articles':
          return `${prefix} none collected`;
        case 'not_scored':
          return `${prefix} ${counted}, none scored for tone`;
        case 'too_few_polarised':
          return `${prefix} ${counted}, too few with a clear tone to score`;
        default:
          return `${prefix} ${counted}, tone ${tone} (${model})`;
      }
    },
  },
};

/** Hebrew counts a single one with "אחד/אחת" after the noun, as the web catalogue does. */
function hebrewCount(count: number, one: string, many: string): string {
  return count === 1 ? one : `${ltr(count)} ${many}`;
}

/** Every one is grammatically masculine, so the verb in `marketLine` agrees with all four. */
const HE_BENCHMARKS: Record<MarketBenchmarkSymbol, string> = {
  SPY: `מדד ${ltr('S&P 500')}`,
  QQQ: `מדד נאסד"ק ${ltr(100)}`,
  IWM: `מדד ראסל ${ltr(2000)}`,
  'BTC-USD': 'הביטקוין',
};

const HE_TOOLS: Record<ScanToolName, string> = {
  search_universe: 'חיפוש ביקום המסחר',
  get_quote: 'מחיר עדכני',
  get_price_history: 'היסטוריית מחירים',
  get_findings: 'ממצאים',
  get_news: 'חדשות',
  get_position: 'פוזיציה',
  explain_concept: 'מילון מונחים',
};

function heDays(days: number): string {
  if (days === 1) return 'יום אחד';
  if (days === 2) return 'יומיים';
  return `${ltr(days)} ימים`;
}

function heTradingDays(days: number): string {
  return days === 1 ? 'יום מסחר אחד' : `${ltr(days)} ימי מסחר`;
}

function heCheck({ tool, subject, days }: EvidenceChecked['checks'][number]): string {
  const parts = [HE_TOOLS[tool]];
  if (subject !== null) parts.push(QUOTED_TOOLS.has(tool) ? `"${isolated(subject)}"` : ltr(subject));
  if (days !== null && tool === 'get_price_history') parts.push(`(${heTradingDays(days)})`);
  if (days !== null && tool === 'get_news') parts.push(`(${heDays(days)})`);
  return parts.join(' ');
}

const he: Messages = {
  locale: 'he-IL',
  numberLocale: 'he-IL',

  buttons: { approve: 'אישור', reject: 'דחייה', snooze: 'השהיה', confirm: 'אישור סופי' },
  undoButton: '↩ ביטול האישור',
  working: {
    approve: '⏳ מאשר…',
    reject: '⏳ דוחה…',
    snooze: '⏳ משהה…',
    undo: '⏳ מבטל…',
    confirm: '⏳ מבצע…',
    recheck: '⏳ בודק שוב…',
  },
  openInApp: 'פתיחה באפליקציה',

  decisionReplies: {
    approved: 'אושר ✓ — נרשם ביומן הווירטואלי שלך. שום פקודה לא בוצעה.',
    pending: 'האישור בוטל ✓ — השאלה פתוחה שוב.',
    rejected: 'נדחה ✓',
    expired: 'פג התוקף — פתחו את האפליקציה לתמונה המעודכנת.',
  },
  snoozedFor: (hours) => `הושהה ל־${ltr(hours)} שעות`,
  refusalReplies: {
    not_undoable: 'אפשר לבטל רק אישור.',
    already_decided: 'כבר הוכרע — פתחו את האפליקציה כדי לראות איך.',
    not_for_trades: 'עסקה אפשר רק לאשר או לדחות.',
  },
  undoTooLate: (seconds) => `מאוחר מדי לבטל — אפשר לבטל אישור רק בתוך ${ltr(seconds)} שניות.`,
  outcomeLines: {
    approved: '✅ אושר — נרשם ביומן הווירטואלי שלך. שום פקודה לא בוצעה.',
    rejected: '❌ נדחה',
    snoozed: '⏸ הושהה — עדיין פתוח; אפשר להכריע בכל עת לפני שיפוג תוקפו',
    expired: '⏳ פג תוקף — כבר אי אפשר לענות',
    pending: '↩ האישור בוטל — פתוח שוב; דבר לא נשאר ביומן שלך',
  },
  nowState: (state) => `המצב כעת: ${ltr(state)}.`,
  proposalGone: 'ההצעה הזו כבר לא קיימת.',
  rateLimited: (minutes) =>
    `יותר מדי בקשות בזמן קצר. נסו שוב ${minutes === 1 ? 'בעוד דקה' : minutes === 2 ? 'בעוד שתי דקות' : `בעוד ${minutes} דקות`}.`,
  cannotChange: 'כבר אי אפשר לשנות את זה.',
  stillWorking: 'עדיין מטפל בזה…',
  buttonUnusable: 'הכפתור הזה כבר לא שמיש.',
  buttonInvalid: 'הכפתור הזה לא תקף בצ׳אט הזה.',

  nothingPending: 'שום דבר לא ממתין לך.',
  muteUsage: `נסו ${ltr('/mute 2h')} או ${ltr('/mute 30m')}.`,
  mutedUntil: (until) => `מושתק עד ${isolated(until)}. ממצאים עדיין מגיעים לפיד ולסיכום היומי.`,
  disconnected: 'החיבור נותק. התיק שלך עדיין במעקב; שום דבר לא יישלח לכאן.',
  severities: { info: 'מידע', notable: 'בולט', high: 'גבוה' },
  unmuted: 'ההתראות פועלות שוב.',
  connected: `מחובר. ההתראות יגיעו לכאן. ${ltr('/help')} מציג מה הבוט יודע לעשות.`,
  chatTaken: 'הצ׳אט הזה כבר מחובר לחשבון אחר.',
  linkUsed: 'בקישור הזה כבר השתמשו. צרו קישור חדש.',
  linkInvalid: 'הקישור הזה לא תקף או שפג תוקפו. צרו קישור חדש.',
  privateChatOnly:
    'הבוט עובד רק בצ׳אט פרטי: בקבוצה כל החברים היו רואים את התיק שלך. פתחו שוב את הקישור מההגדרות והתחברו בצ׳אט עם הבוט עצמו.',

  menu: {
    commands: {
      help: 'מה הבוט יודע לעשות',
      portfolio: 'התיק האמיתי שלך: שווי ושינוי יומי',
      agents: 'הסוכנים המדומים שלך: סריקה, השהיה, לו״ז, ריצה אחרונה',
      pending: 'הצעות שממתינות לך',
      status: 'התראות והשתקה',
      mute: `השתקת התראות: ${ltr('/mute 2h')} או ${ltr('/mute 30m')}`,
      unmute: 'הפעלת ההתראות מחדש',
      new: 'שיחה חדשה עם העוזר',
      stop: 'ניתוק הצ׳אט הזה',
    },
    help: [
      `🧭 ${ltr('Traders')}`,
      'כתבו כל שאלה והעוזר יענה עליה.',
      '',
      `${ltr('/portfolio')} - התיק האמיתי שלך: שווי ושינוי יומי`,
      `${ltr('/agents')} - הסוכנים המדומים שלך: סריקה עכשיו, השהיה, שינוי לו״ז, הריצה האחרונה`,
      `${ltr('/pending')} - הצעות שממתינות לך`,
      `${ltr('/status')} - התראות והשתקה`,
      `${ltr('/mute 2h')} · ${ltr('/unmute')} - השתקה או חידוש של ההתראות`,
      `${ltr('/new')} - שיחה חדשה עם העוזר`,
      `${ltr('/stop')} - ניתוק הצ׳אט הזה`,
      '',
      'שום דבר כאן לא שולח פקודה: אישורים נרשמים ביומן הווירטואלי בלבד.',
    ].join('\n'),
    buttons: {
      portfolio: '📊 תיק',
      agents: '🤖 סוכנים',
      status: '🔔 מצב / השתקה',
      pending: '⏳ ממתינות',
      refresh: '🔄 רענון',
      menu: '➡️ תפריט',
      lastRun: '📜 ריצה אחרונה',
      backToAgents: '➡️ סוכנים',
      backToAgent: '➡️ סוכן',
      mute: (hours) => (hours === 1 ? '🔕 השתקה לשעה' : `🔕 השתקה ל־${ltr(hours)} שעות`),
      unmute: '🔔 ביטול השתקה',
      runScan: '▶️ סריקה עכשיו',
      pause: '⏸ השהיה',
      resume: '▶️ חידוש',
      schedule: '⏱ לו״ז',
      cancel: '✖️ ביטול',
      confirmRun: (cost) => `✅ הרצה (כ־${ltr(cost)})`,
      everyHours: (hours) => (hours === 1 ? 'כל שעה' : `כל ${ltr(hours)} ש׳`),
      noMarketHours: 'ללא',
      preOpen: (on) => `${on ? '✅' : '⬜'} לפני הפתיחה`,
      postClose: (on) => `${on ? '✅' : '⬜'} אחרי הסגירה`,
    },
    asOf: (time) => `נכון ל־${ltr(time)}`,
    unavailable: 'לא הצלחתי לטעון את זה כרגע. נסו שוב בעוד דקה.',
    portfolio: {
      title: '📊 התיק שלך',
      empty: 'עדיין אין אחזקות. הוסיפו אותן באפליקציה.',
      value: (value) => `שווי: ${ltr(value)}`,
      today: (change, percent) => `היום: ${ltr(change)} (${ltr(percent)})`,
      todayUnknown: 'היום: לא ידוע - אין מחיר סגירה קודם להשוואה',
      holdings: (count, priced) =>
        count === priced
          ? `${hebrewCount(count, 'אחזקה אחת', 'אחזקות')}, לכולן יש מחיר`
          : `${hebrewCount(count, 'אחזקה אחת', 'אחזקות')}, ל־${ltr(priced)} יש מחיר`,
      unpriced: (symbols) =>
        `⚠️ אין מחיר ל־${symbols.map(ltr).join(', ')}: לא נכללו בשווי, ולא נספרו כאפס.`,
      stale: 'חלק מהמחירים מעוכבים או ממחיר הסגירה האחרון.',
      agentsApart: `הסוכנים המדומים לא נכללים: ראו ${ltr('/agents')}.`,
    },
    status: {
      title: '🔔 התראות',
      alertingFrom: (severity) => `התראות מרמת ${severity} ומעלה.`,
      mutedUntil: (until) => `🔕 מושתק עד ${isolated(until)}.`,
      notMuted: 'לא מושתק.',
      quietHours: (start, end) => `שעות שקט ${ltr(`${start}-${end}`)}.`,
      mutedToast: (hours) => (hours === 1 ? 'הושתק לשעה' : `הושתק ל־${ltr(hours)} שעות`),
      unmutedToast: 'ההתראות פועלות',
    },
    pending: {
      title: '⏳ ממתינות לך',
      states: { pending: 'ממתינה', snoozed: 'מושהית', approved: 'אושרה', rejected: 'נדחתה', expired: 'פג תוקף' },
    },
    agents: {
      title: '🤖 הסוכנים שלך',
      empty: 'עדיין אין סוכנים מדומים. צרו סוכן באפליקציה.',
      choose: 'בחרו סוכן כדי לראות את הלו״ז ואת הסריקה האחרונה.',
      gone: 'הסוכן הזה כבר לא קיים.',
      scansADay: (count) =>
        count === 0 ? 'לפי בקשה' : count === 1 ? 'סריקה אחת ביום' : `${ltr(count)} סריקות ביום`,
    },
    agent: {
      states: { active: 'פעיל', paused: 'מושהה' },
      running: (since) => `🔄 סורק עכשיו (מאז ${isolated(since)})`,
      schedule: (slots) => `לו״ז: ${slots.join(' · ')}, בימי מסחר`,
      onlyWhenAsked: 'לו״ז: אין - סורק רק כשמבקשים',
      nextScan: (at) => `הסריקה הבאה: ${isolated(at)}`,
      nextScanUnknown: 'הסריקה הבאה: לא ידוע כרגע (לא ניתן היה לקרוא את לוח המסחר)',
      notScheduledHere: 'סריקות מתוזמנות כבויות בהתקנה הזו.',
      waitingForBrief: 'ממתין להוראות או להגדרות: הוא לא סורק עד שיהיו לו.',
      cash: (cash, deposited) => `מזומן: ${ltr(cash)} מתוך ${ltr(deposited)} שהופקדו`,
      netWorth: (worth, pnl, percent) => `שווי נקי: ${ltr(worth)} (רווח/הפסד ${ltr(pnl)}, ${ltr(percent)})`,
      unpriced: (symbols) => `⚠️ אין מחיר ל־${symbols.map(ltr).join(', ')}: השווי הנקי לא ידוע.`,
      holdings: (count) => hebrewCount(count, 'אחזקה אחת', 'אחזקות'),
      spentToday: (spent, budget) => `הוצאת בינה מלאכותית היום: ${ltr(spent)} מתוך ${ltr(budget)}`,
    },
    log: {
      title: (agent) => `📜 ${isolated(agent)}: הסריקה האחרונה`,
      none: 'עדיין אין סריקות.',
      started: (at, trigger) => `${isolated(at)}, ${trigger}`,
      triggers: { manual: 'הורצה על ידך', schedule: 'מתוזמנת', refresh: 'בדיקה חוזרת' },
      running: 'עדיין רצה.',
      outcome: (outcome) => `תוצאה: ${outcome}`,
      outcomes: {
        trade: 'הציע עסקאות',
        no_trade: 'ללא עסקה',
        invalid_answer: 'לא ניתן היה לקרוא את התשובה',
        budget_reached: 'תקציב הבינה המלאכותית היומי של הסוכן נגמר',
        step_limit: 'נעצרה במגבלת הצעדים',
        failed: 'נכשלה',
        rule_rejected: 'נדחתה בבדיקות',
        cap_reached: 'הגעת למגבלת הבינה המלאכותית החודשית שלך',
        own_key_failed: `מפתח ה־${ltr('OpenRouter')} שלך נדחה`,
      },
      trade: (side, quantity, symbol) => `• ${side === 'buy' ? 'קנייה' : 'מכירה'} של ${ltr(quantity)} ${ltr(symbol)}`,
      proposalNow: (state) => ` - ${state}`,
      refused: (problems) => ` - לא הוצעה: ${isolated(problems)}`,
      cost: (cost, model) => (model === null ? `עלות ${ltr(cost)}` : `עלות ${ltr(cost)} (${ltr(model)})`),
      fullOnDecisions: 'התמליל המלא בלשונית ההחלטות של הסוכן.',
    },
    run: {
      confirm: (agent, cost, spent, budget) =>
        [
          `▶️ להריץ עכשיו סריקה של ${isolated(agent)}?`,
          `העלות כ־${ltr(cost)}, מתקציב הבינה המלאכותית של הסוכן (${ltr(spent)} מתוך ${ltr(budget)} נוצלו היום).`,
          'כל מה שיוצע יגיע לכאן לאישורך. שום דבר לא נקנה או נמכר באמת.',
        ].join('\n'),
      startedToast: 'סורק - התוצאה תופיע כאן.',
      running: (agent) => `🔄 ${isolated(agent)} סורק. התוצאה תופיע כאן בעוד כדקה.`,
      refusals: {
        agent_not_active: 'הסוכן מושהה: חדשו אותו כדי לסרוק.',
        no_persona: 'לסוכן אין הוראות או הגדרות להחליט לפיהן.',
        scan_running: 'הסוכן סורק ממש עכשיו.',
        budget_spent: 'תקציב הבינה המלאכותית של הסוכן להיום נוצל.',
        no_model: 'לא נבחר מודל לסוכנים (דף הניהול).',
        other: 'הסריקה לא הצליחה לרוץ.',
      },
      failed: (reason) => `⚠️ הסריקה לא הסתיימה: ${reason}`,
    },
    control: {
      pausedToast: 'הושהה - אין סריקות מתוזמנות עד שתחדשו אותו.',
      resumedToast: 'חודש.',
      scheduleSavedToast: 'הלו״ז נשמר.',
      limitReached: (max) => `כבר יש לך ${ltr(max)} סוכנים פעילים, המספר המרבי: השהו אחד קודם.`,
      expired: 'תוקף הכפתור פג - זו התצוגה העדכנית.',
      refused: 'לא ניתן היה לשנות את זה.',
    },
    schedule: {
      title: (agent) => `⏱ ${isolated(agent)}: מתי הוא סורק`,
      hint: (first) => `סריקות בשעות המסחר מתחילות ב־${first} וחוזרות במרווח שנבחר עד הסגירה; בימי מסחר בלבד.`,
    },
  },

  tradeProposalHeadline: (agent, side, quantity, symbol, price) =>
    `${isolated(agent)} מציע ${side === 'buy' ? 'לקנות' : 'למכור'} ${ltr(quantity)} ${ltr(symbol)} ב־${ltr(price)}`,
  tradeFundedBy: (symbols) => ` - במימון מכירת ${symbols.map(ltr).join(', ')}: אשרו אותה קודם`,

  moveWithDrawdown: (f) => ({
    headline: `מחיר ${ltr(f.symbol)} ${f.direction === 'fell' ? 'ירד' : 'עלה'} ב־${ltr(f.change)} ל־${ltr(f.price)}`,
    explanation:
      `כעת ${ltr(f.drawdown)} מתחת ל${f.windowDays === null ? 'שיא האחרון' : `שיא של ${ltr(f.windowDays)} יום`}, ${ltr(f.high)}` +
      (f.sigma === null ? '.' : `; התנועה הייתה ${ltr(f.sigma)} סטיות תקן מהממוצע האחרון.`),
  }),

  marketLine: (f) =>
    `באותו יום ${HE_BENCHMARKS[f.benchmark]} (${ltr(f.benchmark)}) ${f.direction === 'fell' ? 'ירד' : 'עלה'} ב־${ltr(f.change)}.`,

  evidenceChecked: ({ checks, otherCalls }) => {
    const parts = checks.map(heCheck);
    if (otherCalls > 0) parts.push(otherCalls === 1 ? 'כלי נוסף אחד' : `${ltr(otherCalls)} כלים נוספים`);
    return parts.length === 0
      ? 'נבדק: כלום - הסוכן החליט על סמך התדריך בלבד.'
      : `נבדק: ${parts.join(' · ')}`;
  },

  trade: {
    previewToast: 'בדקו את המחיר העדכני, ואז אישור סופי.',
    preview: (f) =>
      [
        `במחיר העדכני: ${f.side === 'buy' ? 'קנייה' : 'מכירה'} של ${ltr(f.quantity)} ${ltr(f.symbol)} ב־${ltr(f.livePrice)}`,
        `המחיר של הסוכן ${ltr(f.agentPrice)} (${ltr(f.distance)})`,
        `עלות ${ltr(f.notional)}, עמלה ${ltr(f.fee)}; מזומן אחרי ${ltr(f.cashAfter)}`,
        `האישור הסופי מבוצע בטווח ${ltr(f.band)} מ־${ltr(f.livePrice)}. יומן וירטואלי בלבד - שום פקודה לא נשלחת.`,
      ].join('\n'),
    filledToast: 'בוצע ✓ — נרשם ביומן הווירטואלי. שום פקודה לא בוצעה.',
    filled: (f) =>
      `✅ ${f.side === 'buy' ? 'נקנו' : 'נמכרו'} ${ltr(f.quantity)} ${ltr(f.symbol)} ב־${ltr(f.price)}, עמלה ${ltr(f.fee)}; מזומן ${ltr(f.cash)} (${ltr(f.at)}). יומן וירטואלי - שום פקודה לא בוצעה.`,
    refused: (reason, at) => `⚠️ לא אושר (${ltr(at)}): ${reason} ההצעה פתוחה עד שיפוג תוקפה.`,
    reasons: {
      quote_too_old: 'המחיר האחרון ישן מדי למסחר.',
      quote_unavailable: 'אין כרגע מחיר זמין.',
      price_moved: `המחיר זז ביותר מ־${ltr('0.5%')} מאז התצוגה המקדימה. אשרו שוב למחיר החדש.`,
      insufficient_cash: 'לסוכן אין מספיק מזומן לעסקה ולעמלה.',
      insufficient_holding: 'הסוכן כבר לא מחזיק מספיק מניות.',
      not_tradable: 'אי אפשר לסחור בנכס הזה.',
      agent_archived: 'הסוכן בארכיון.',
      other: 'העסקה נדחתה.',
    },
    marketClosed: (nextOpen) => `הבורסה סגורה; היא נפתחת ${isolated(nextOpen)}.`,
    farFromAgent: (agentPrice, livePrice, distance) =>
      `המחיר ${ltr(livePrice)}, ${ltr(distance)} מהמחיר של הסוכן ${ltr(agentPrice)} - יותר מ־${ltr('3%')}.`,
    confirmInApp: 'המחיר גדול מדי לכפתור בטלגרם: אשרו אותו באפליקציה.',
  },

  ask: {
    noReply: {
      failed: 'לא נמצאה תשובה שאפשר לבדוק מול הנתונים, ולכן לא מוצגת תשובה. נסו לשאול שוב, או בצורה ממוקדת יותר.',
      budget_reached: 'הגעתם למגבלת ההוצאה היומית על שאלות. אפשר לשאול שוב אחרי חצות.',
      cap_reached: 'הגעתם למגבלת ההוצאה החודשית של החשבון. אפשר לשאול שוב כשיתחיל החודש הבא.',
      no_model: 'העוזר צריך מודל, ולא הוגדר אחד. מנהל יכול לבחור מודל בדף הניהול.',
      own_key_failed: `${ltr('OpenRouter')} דחה את מפתח ה־${ltr('API')} שלכם, ולכן השאלה לא נענתה. בהגדרות מוסבר למה; עד שתשמרו מפתח תקין, השאלות עוברות דרך חשבון המערכת במסגרת המגבלה החודשית.`,
    },
    tooLong: (limit) => `השאלה ארוכה מדי. נסחו אותה בעד ${ltr(limit)} תווים.`,
    stillAnswering: 'עדיין עונה על השאלה הקודמת. שלחו את זו שוב כשהתשובה תגיע.',
    unavailable: 'לא הצלחתי להגיע לעוזר, ולכן השאלה לא נענתה. נסו שוב בעוד דקה.',
    textOnly: 'אני קורא טקסט בלבד. כתבו את השאלה כהודעה.',
    sources: 'מקורות:',
    newConversation: 'שיחה חדשה. השאלה הבאה שלכם תפתח אותה.',
  },
  recheck: {
    button: '🔄 בדיקה חוזרת',
    startedToast: 'בודק שוב במחיר של היום - התשובה תגיע כאן.',
    proposed: (at) => `🔄 נבדק שוב (${ltr(at)}): הצעה חדשה בהודעה הבאה.`,
    declined: (at, reason) => `🔄 נבדק שוב (${ltr(at)}): אין הצעה חדשה. ${reason}`,
    unanswered: (at, cause) => `🔄 הבדיקה החוזרת לא הסתיימה (${ltr(at)}): ${cause} אפשר לנסות שוב.`,
    agentSaid: (thesis) => `הסוכן: ${thesis}`,
    checks: {
      malformed: 'לא ניתן היה לקרוא את תשובת הסוכן.',
      decision_limit: 'הסוכן ענה ביותר מעסקה אחת.',
      duplicate: 'הסוכן ציין את אותה עסקה פעמיים.',
      already_waiting: 'אותה עסקה כבר ממתינה לאישורך.',
      not_tradable: 'כבר אי אפשר לסחור כאן בנכס הזה.',
      holding: 'הסוכן כבר לא מחזיק מספיק מניות למכירה.',
      thesis: 'הנימוק של הסוכן ארוך מכדי להציג אותו.',
      figures: 'הנימוק של הסוכן ציטט נתונים שאינם בראיות.',
      no_price: 'אין כרגע מחיר זמין.',
      too_small: 'המכירה תכניס פחות מהעמלה שלה.',
      cash: 'לסוכן אין מספיק מזומן לעסקה ולעמלה.',
      mandate: 'העסקה כבר לא מתאימה להגדרות הסוכן.',
      not_this_trade: 'הסוכן הציע עסקה אחרת, ובדיקה חוזרת לא יכולה להציע אותה.',
      no_answer: 'הסוכן לא נתן תשובה שהשרת יכול לבדוק.',
    },
    causes: {
      failed: 'היא נכשלה.',
      budget_reached: 'תקציב הבינה המלאכותית היומי של הסוכן נגמר.',
      cap_reached: 'הגעת למגבלת הבינה המלאכותית החודשית שלך.',
      own_key_failed: `מפתח ה־${ltr('OpenRouter')} שלך הפסיק לעבוד.`,
    },
    refusals: {
      not_expired: 'אפשר לבדוק שוב רק הצעה שפג תוקפה.',
      recheck_window_passed: `תוקפה פג לפני יותר מ־${ltr(RECHECK_WINDOW_DAYS)} ימים.`,
      already_rechecked: 'ההצעה הזו כבר נבדקה שוב.',
      superseded: 'הצעה מאוחרת יותר לאותה עסקה אושרה, אז אין מה לבדוק שוב.',
      budget_spent: 'תקציב הבינה המלאכותית של הסוכן להיום נוצל.',
      scan_running: 'הסוכן סורק כרגע - נסו שוב בעוד דקה.',
      agent_not_active: 'הסוכן מושהה או בארכיון.',
      no_persona: 'לסוכן אין הוראות או הגדרות להחליט לפיהן.',
      other: 'הבדיקה החוזרת לא הצליחה לרוץ.',
    },
  },

  signup: {
    request: (email, timezone) =>
      `בקשת הרשמה חדשה\n\n${ltr(email)}\nאזור זמן: ${ltr(timezone)}\n\nאשרו כדי לצרף אותם עם תקרת הוצאה חודשית על בינה מלאכותית.`,
    buttons: {
      approveDefault: (cap) => `אישור, ${ltr(cap)} לחודש`,
      reject: 'דחייה',
      custom: 'תקציב אחר',
      amount: (cap) => `${ltr(cap)} לחודש`,
      otherAmount: 'סכום אחר',
    },
    otherAmountInApp: 'לסכום אחר, אשרו בעמוד הניהול.',
    approvedToast: 'אושר.',
    rejectedToast: 'נדחה.',
    chooseAmountToast: 'בחרו תקרה חודשית.',
    approvedLine: (cap, at) => `✅ אושר עם ${ltr(cap)} לחודש (${ltr(at)}). עדכנו אותם שאפשר להתחבר.`,
    rejectedLine: (at) => `❌ נדחה (${ltr(at)}).`,
    already: {
      pending: 'הבקשה עדיין ממתינה.',
      active: 'כבר אושר.',
      rejected: 'כבר נדחה.',
      disabled: 'החשבון הושבת.',
      gone: 'הבקשה כבר לא קיימת.',
    },
  },

  scheduledScans: {
    slot: (slot) =>
      slot === 'pre_open'
        ? 'לפני הפתיחה'
        : slot === 'post_close'
          ? 'אחרי הסגירה'
          : `${ltr(slotClock(slot))} שעון ניו יורק`,
    causes: {
      rate_limited: 'ספק המודל מגביל את קצב הבקשות',
      provider_error: 'ספק המודל או שירות ה־AI החזירו שגיאה',
      timeout: 'הסריקה לא הסתיימה בזמן',
      agent_busy: 'הסוכן עדיין היה עסוק בסריקה אחרת',
      no_model: 'לא נבחר מודל לסוכנים (דף הניהול)',
      scan_failed: 'קריאת המודל נכשלה במהלך הסריקה',
      window_closed: 'חלון הזמן שלה נגמר לפני שאפשר היה לנסות שוב',
    },
    gaveUp: (agent, slot, day, cause) => ({
      headline: `⚠️ הסריקה של ${isolated(agent)} (${slot}, ${ltr(day)}) לא רצה`,
      explanation: `היא הפסיקה לנסות כי ${cause}. שום דבר לא הוצע; הסריקה המתוזמנת הבאה תרוץ כרגיל. הפרטים בלשונית ההחלטות של הסוכן.`,
    }),
  },

  narration: {
    narrating: {
      headline: 'ההסברים נכתבים שוב על ידי המודל',
      explanation:
        'ממצאים חדשים מוסברים שוב במונחים שלהם, וכל נתון עדיין נבדק מול הראיות לפני שהוא נשמר.',
    },
    off: {
      headline: 'ההסברים נכתבים מתבניות: לא מוגדר מודל',
      explanation: 'כל נתון עדיין נבדק ועדיין נכון; הניסוח קבוע. זו הגדרה, לא תקלה.',
    },
    rejected: {
      headline: 'ההסברים חזרו לתבניות: פלט המודל נדחה',
      explanation:
        'המודל עונה, והמשפטים שלו מכילים נתונים שאינם בראיות, ולכן משתמשים בתבניות ושום דבר שגוי לא הגיע אליך. מודל מתאים יותר הוא הפתרון; המתנה לא.',
    },
    exhausted: {
      headline: 'ההסברים חזרו לתבניות: תקרת ההוצאה הושגה',
      explanation: 'הקריאות למודל נעצרו בגלל התקציב. משתמשים בתבניות עד שהתקרה תתאפס או תוגדל.',
    },
    unavailable: {
      headline: 'ההסברים חזרו לתבניות: המודל לא זמין',
      explanation:
        'הספק דחה או נכשל בבקשות האחרונות. בינתיים משתמשים בתבניות; לעתים קרובות זה מסתדר מעצמו.',
    },
  },
  narrationFallback: {
    headline: 'אופן כתיבת ההסברים השתנה',
    explanation: 'כל נתון בהם עדיין נבדק מול הראיות לפני שהוא מוצג.',
  },

  digest: {
    title: (findings, topics, narrationChanged) => {
      const parts: string[] = [];
      if (findings > 0) parts.push(hebrewCount(findings, 'ממצא אחד', 'ממצאים'));
      if (topics > 0) parts.push(hebrewCount(topics, 'נושא אחד', 'נושאים'));
      if (narrationChanged) parts.push('ההסברים השתנו');
      return `סיכום יומי: ${parts.join(', ')}`;
    },
    reasons: {
      below_floor: 'מתחת לסף ההתראה שלך',
      quiet_hours: 'עוכבו בשעות השקט',
      muted: 'עוכבו בזמן השתקה',
      above_floor: 'לא נשלחו כשנמצאו לראשונה',
    },
    reasonLine: (count, reason) => `${ltr(count)} ${reason}`,
    topicsHeading: 'נושאים',
    noUnusualMove: (label) => `${isolated(label)}: אין תנועה חריגה ביממה האחרונה`,
    notMeasured: (label, reason) => `${isolated(label)}: לא נמדד (${isolated(reason)})`,
    notScanned: (label) => `${isolated(label)}: עדיין לא נסרק`,
    news: (days, gap, articles, tone, model) => {
      const prefix = `חדשות, ${ltr(days)} הימים האחרונים:`;
      const counted = hebrewCount(articles, 'כתבה אחת', 'כתבות');
      switch (gap) {
        case 'no_articles':
          return `${prefix} לא נאספו כתבות`;
        case 'not_scored':
          return `${prefix} ${counted}, אף אחת לא דורגה לפי טון`;
        case 'too_few_polarised':
          return `${prefix} ${counted}, מעט מדי עם טון ברור לדירוג`;
        default:
          return `${prefix} ${counted}, טון ${ltr(tone)} (${ltr(model)})`;
      }
    },
  },
};

export const MESSAGES: Record<UiLanguage, Messages> = { en, he };

/** The messages for `language`; anything that is not an interface language is English. */
export function messagesFor(language: string | null | undefined): Messages {
  return MESSAGES[language as UiLanguage] ?? en;
}

/**
 * An observation's words in `language`: its translation when it has one, else
 * the English it was written in. The orchestrator never composes these - see
 * the module docstring - it only chooses between versions the AI service wrote.
 */
export function observationTextIn<T extends { headline: string; explanation: string | null }>(
  observation: T & { localized?: LocalizedTexts | null },
  language: string,
): { headline: string; explanation: string | null } {
  const translated =
    language === 'en' ? undefined : observation.localized?.[language as TranslatedLanguage];
  return translated ?? { headline: observation.headline, explanation: observation.explanation };
}
