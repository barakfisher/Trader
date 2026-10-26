/**
 * Every email the app sends, in each interface language (guideline 1, D258).
 *
 * A typed record, as `notify/messages.ts` is for Telegram: a sentence missing in
 * one language is a compile error. Each message is written once as paragraphs
 * and rendered twice - plain text and a small HTML document carrying `lang` and
 * `dir` - so a Hebrew mail is laid out right to left in clients that read HTML.
 * Links and addresses are Latin text inside a Hebrew line, so they are wrapped
 * in isolates there, as Telegram's figures are.
 */

import type { UiLanguage } from '@traders/shared';

import type { EmailMessage } from './sender.js';

/** A paragraph, or a link the HTML makes clickable. */
type Block = string | { link: string };

interface Draft {
  subject: string;
  blocks: Block[];
}

interface EmailCatalogue {
  /** A new sign-up's link (D259). */
  verifyEmail(link: string, hours: number): Draft;
  /** Sign-up with an address that already has an account or request (D298). */
  signupExists(signInLink: string): Draft;
  /** A changed address's link, sent to the new address (D259). */
  verifyNewEmail(link: string, hours: number): Draft;
  /** To the current address, when a change to another one is asked for (D259). */
  emailChangeRequested(newEmail: string): Draft;
}

const isolate = (text: string) => `⁨${text}⁩`;

const CATALOGUE: Record<UiLanguage, EmailCatalogue> = {
  en: {
    verifyEmail: (link, hours) => ({
      subject: 'Confirm your email for Traders',
      blocks: [
        'Confirm this address to finish signing up for Traders:',
        { link },
        `The link works once and expires in ${hours} hours. If you did not sign up, ignore this email - nothing is created until the link is opened.`,
      ],
    }),
    signupExists: (signInLink) => ({
      subject: 'Someone tried to sign up to Traders with your address',
      blocks: [
        'Someone asked to create a Traders account with this address, which already has an account or a request.',
        'If it was you, sign in instead:',
        { link: signInLink },
        'If it was not you, you can ignore this email: nothing was changed.',
      ],
    }),
    verifyNewEmail: (link, hours) => ({
      subject: 'Confirm your new Traders sign-in address',
      blocks: [
        'Confirm this address as the new sign-in address of your Traders account:',
        { link },
        `The link works once and expires in ${hours} hours. Until it is opened, you sign in with your current address.`,
      ],
    }),
    emailChangeRequested: (newEmail) => ({
      subject: 'A change of your Traders sign-in address was requested',
      blocks: [
        `Someone signed in to your Traders account asked to change its sign-in address to ${newEmail}.`,
        'Nothing changes until that address is confirmed - you still sign in with this one.',
        'If this was not you, sign in, change your password, and sign out the devices you do not recognise in Settings.',
      ],
    }),
  },
  he: {
    verifyEmail: (link, hours) => ({
      subject: 'אישור כתובת האימייל שלכם ב-Traders',
      blocks: [
        'אשרו את הכתובת הזו כדי להשלים את ההרשמה ל-Traders:',
        { link },
        `הקישור עובד פעם אחת ותוקפו פג בעוד ${hours} שעות. אם לא נרשמתם, התעלמו מהאימייל הזה - שום דבר לא נוצר עד שהקישור נפתח.`,
      ],
    }),
    signupExists: (signInLink) => ({
      subject: 'מישהו ניסה להירשם ל-Traders עם הכתובת שלכם',
      blocks: [
        'מישהו ביקש ליצור חשבון Traders עם הכתובת הזו, שכבר יש לה חשבון או בקשה.',
        'אם זה הייתם אתם, התחברו במקום זאת:',
        { link: signInLink },
        'אם זה לא הייתם אתם, אפשר להתעלם מהאימייל הזה: שום דבר לא השתנה.',
      ],
    }),
    verifyNewEmail: (link, hours) => ({
      subject: 'אישור כתובת ההתחברות החדשה שלכם ב-Traders',
      blocks: [
        'אשרו את הכתובת הזו ככתובת ההתחברות החדשה של חשבון ה-Traders שלכם:',
        { link },
        `הקישור עובד פעם אחת ותוקפו פג בעוד ${hours} שעות. עד שייפתח, אתם מתחברים עם הכתובת הנוכחית.`,
      ],
    }),
    emailChangeRequested: (newEmail) => ({
      subject: 'התבקש שינוי של כתובת ההתחברות שלכם ב-Traders',
      blocks: [
        `מישהו שמחובר לחשבון ה-Traders שלכם ביקש לשנות את כתובת ההתחברות שלו ל-${isolate(newEmail)}.`,
        'שום דבר לא משתנה עד שהכתובת הזו תאושר - אתם עדיין מתחברים עם הכתובת הזו.',
        'אם זה לא הייתם אתם, התחברו, החליפו את הסיסמה ונתקו בהגדרות את המכשירים שאינכם מזהים.',
      ],
    }),
  },
};

const DIRECTION: Record<UiLanguage, 'ltr' | 'rtl'> = { en: 'ltr', he: 'rtl' };

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** A draft as the message the sender takes: the text, and the same as HTML in the language's direction. */
function render(to: string, language: UiLanguage, draft: Draft): EmailMessage {
  const rtl = DIRECTION[language] === 'rtl';
  const text = draft.blocks
    .map((block) => (typeof block === 'string' ? block : rtl ? isolate(block.link) : block.link))
    .join('\n\n');
  const paragraphs = draft.blocks
    .map((block) =>
      typeof block === 'string'
        ? `<p>${escapeHtml(block)}</p>`
        : // A link is one long word: it may break anywhere, or a phone scrolls sideways and the text leaves the screen.
          `<p dir="ltr" style="word-break:break-all"><a href="${escapeHtml(block.link)}">${escapeHtml(block.link)}</a></p>`,
    )
    .join('\n');
  const html =
    `<!doctype html><html lang="${language}" dir="${DIRECTION[language]}">` +
    // Without a viewport a phone lays the mail out at desktop width and shows its left edge.
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
    `<body style="font-family:sans-serif;line-height:1.5;max-width:36em;margin:0 auto;padding:1em">\n${paragraphs}\n</body></html>`;
  return { to, subject: draft.subject, text, html };
}

/** The message for `to` in `language`: one function per kind, so a caller cannot pass the wrong arguments. */
export const emailMessages = {
  verifyEmail: (to: string, language: UiLanguage, link: string, hours: number) =>
    render(to, language, CATALOGUE[language].verifyEmail(link, hours)),
  signupExists: (to: string, language: UiLanguage, signInLink: string) =>
    render(to, language, CATALOGUE[language].signupExists(signInLink)),
  verifyNewEmail: (to: string, language: UiLanguage, link: string, hours: number) =>
    render(to, language, CATALOGUE[language].verifyNewEmail(link, hours)),
  emailChangeRequested: (to: string, language: UiLanguage, newEmail: string) =>
    render(to, language, CATALOGUE[language].emailChangeRequested(newEmail)),
};
