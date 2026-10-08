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
 * frames them.
 *
 * Figures and Latin-script fragments in the Hebrew are wrapped in isolates, as
 * the AI service's Hebrew templates are (`hebrew_templates.py`): a left-to-right
 * isolate for a figure, a first-strong isolate for text the user wrote (a topic
 * label can be in either script). Telegram renders plain text, so markup cannot
 * do this job there; the isolates are invisible.
 */

import type {
  DigestReason,
  LocalizedTexts,
  TopicSentimentGap,
  TranslatedLanguage,
  UiLanguage,
} from '@traders/shared';

import type { CallbackAction } from '../telegram/callbackToken.js';
import type { FailureCause } from '../services/scheduledScans.js';
import type { ScanSlot } from '../services/scanSchedule.js';
import type { NarrationState } from '../services/narrationHealth.js';
import type { RefusalReason } from '../services/proposalState.js';

/** LEFT-TO-RIGHT ISOLATE ... POP: a figure, kept left to right in a Hebrew line. */
export function ltr(text: string | number): string {
  return `\u2066${text}\u2069`;
}

/** FIRST-STRONG ISOLATE ... POP: text whose direction is its own, such as a label. */
export function isolated(text: string): string {
  return `\u2068${text}\u2069`;
}

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
  alertingFrom: (severity: string) => string;
  commands: string;
  connected: string;
  chatTaken: string;
  linkUsed: string;
  linkInvalid: string;

  /** A trade proposal's headline (D51: the frame is the catalogue's; the thesis the model's). */
  tradeProposalHeadline: (agent: string, side: 'buy' | 'sell', quantity: string, symbol: string, price: string) => string;

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

  /** D74: a scheduled slot that gave up, said once. */
  scheduledScans: {
    slots: Record<ScanSlot, string>;
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
  cannotChange: 'That can no longer be changed.',
  stillWorking: 'Still working on it…',
  buttonUnusable: 'This button is no longer usable.',
  buttonInvalid: 'This button is not valid for this chat.',

  nothingPending: 'Nothing waiting on you.',
  muteUsage: 'Try /mute 2h or /mute 30m.',
  mutedUntil: (until) => `Muted until ${until}. Findings still reach your feed and the digest.`,
  disconnected: 'Disconnected. Your portfolio is still being watched; nothing will be sent here.',
  severities: { info: 'info', notable: 'notable', high: 'high' },
  alertingFrom: (severity) =>
    `Alerting on ${severity} and above. Open the app for the full portfolio.`,
  commands: 'Commands: /portfolio /pending /mute /stop',
  connected: 'Connected. Alerts will arrive here.',
  chatTaken: 'This chat is already connected to another account.',
  linkUsed: 'That link has already been used. Generate a new one.',
  linkInvalid: 'That link is not valid or has expired. Generate a new one.',

  tradeProposalHeadline: (agent, side, quantity, symbol, price) =>
    `${agent} proposes to ${side} ${quantity} ${symbol} at ${price}`,

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

  scheduledScans: {
    slots: {
      pre_open: 'pre-open',
      post_close: 'post-close',
      ny_1000: '10:00 New York',
      ny_1400: '14:00 New York',
    },
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
  cannotChange: 'כבר אי אפשר לשנות את זה.',
  stillWorking: 'עדיין מטפל בזה…',
  buttonUnusable: 'הכפתור הזה כבר לא שמיש.',
  buttonInvalid: 'הכפתור הזה לא תקף בצ׳אט הזה.',

  nothingPending: 'שום דבר לא ממתין לך.',
  muteUsage: `נסו ${ltr('/mute 2h')} או ${ltr('/mute 30m')}.`,
  mutedUntil: (until) => `מושתק עד ${ltr(until)}. ממצאים עדיין מגיעים לפיד ולסיכום היומי.`,
  disconnected: 'החיבור נותק. התיק שלך עדיין במעקב; שום דבר לא יישלח לכאן.',
  severities: { info: 'מידע', notable: 'בולט', high: 'גבוה' },
  alertingFrom: (severity) => `התראות מרמת ${severity} ומעלה. התיק המלא באפליקציה.`,
  commands: `פקודות: ${ltr('/portfolio /pending /mute /stop')}`,
  connected: 'מחובר. ההתראות יגיעו לכאן.',
  chatTaken: 'הצ׳אט הזה כבר מחובר לחשבון אחר.',
  linkUsed: 'בקישור הזה כבר השתמשו. צרו קישור חדש.',
  linkInvalid: 'הקישור הזה לא תקף או שפג תוקפו. צרו קישור חדש.',

  tradeProposalHeadline: (agent, side, quantity, symbol, price) =>
    `${isolated(agent)} מציע ${side === 'buy' ? 'לקנות' : 'למכור'} ${ltr(quantity)} ${ltr(symbol)} ב־${ltr(price)}`,

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

  scheduledScans: {
    slots: {
      pre_open: 'לפני הפתיחה',
      post_close: 'אחרי הסגירה',
      ny_1000: `${ltr('10:00')} שעון ניו יורק`,
      ny_1400: `${ltr('14:00')} שעון ניו יורק`,
    },
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
