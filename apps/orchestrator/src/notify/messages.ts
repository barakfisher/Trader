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

export type RecordedNarrationState = Exclude<NarrationState, 'unknown'>;

export interface NoticeText {
  headline: string;
  explanation: string;
}

export interface Messages {
  /** The `Intl` locale for times written into a message. */
  locale: string;

  buttons: Record<'approve' | 'reject' | 'snooze', string>;
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

  buttons: { approve: 'Approve', reject: 'Reject', snooze: 'Snooze' },
  undoButton: '↩ Undo approval',
  working: {
    approve: '⏳ Approving…',
    reject: '⏳ Rejecting…',
    snooze: '⏳ Snoozing…',
    undo: '⏳ Undoing…',
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

  buttons: { approve: 'אישור', reject: 'דחייה', snooze: 'השהיה' },
  undoButton: '↩ ביטול האישור',
  working: {
    approve: '⏳ מאשר…',
    reject: '⏳ דוחה…',
    snooze: '⏳ משהה…',
    undo: '⏳ מבטל…',
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
