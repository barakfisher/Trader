/**
 * An assistant's reply as a Telegram message (D223).
 *
 * The bot sends plain text - no `parse_mode` - because one escaping mistake in
 * Telegram's markup makes it refuse the whole message, and the reply is
 * markdown written by a model. So the markdown is flattened instead of
 * converted: emphasis and headings lose their marks, list items keep a bullet,
 * and a link keeps its words. A link to a page of this app becomes an address
 * only when the installation has a public one (`WEB_BASE_URL`); without it the
 * page is named, which is all a relative path could say in a chat.
 *
 * Sources: the news the answer drew on, at most `MAX_NEWS_SOURCES`, each with
 * its own URL (Telegram makes a bare https address a link). App pages and data
 * are left out: the answer already names them, and a chat cannot open them.
 */

import type { AssistantReply } from '@traders/shared/ai';

import type { Messages } from '../notify/messages.js';

/** News sources listed under an answer: enough to check it, few enough to read. */
export const MAX_NEWS_SOURCES = 3;

/** The outcomes with no reply of the model's: each is a sentence of the catalogue. */
type NoReplyOutcome = keyof Messages['ask']['noReply'];

const NO_REPLY = new Set<string>([
  'failed',
  'budget_reached',
  'cap_reached',
  'no_model',
  'own_key_failed',
  'own_key_required',
]);

function isNoReply(outcome: string): outcome is NoReplyOutcome {
  return NO_REPLY.has(outcome);
}

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Markdown as plain text: the words kept, the marks gone. */
export function flattenMarkdown(markdown: string, linkBase: string | null): string {
  return (
    markdown
      .replace(LINK, (_whole, label: string, href: string) => {
        if (href.startsWith('/')) return linkBase === null ? label : `${label} (${linkBase}${href})`;
        return /^https?:\/\//.test(href) ? `${label} (${href})` : label;
      })
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
      // A single-starred emphasis, once list markers are bullets: "*not*" -> "not".
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/gm, '$1$2')
  );
}

/** The whole message for a reply: the answer, or the catalogue's sentence for its outcome. */
export function plainAnswer(reply: AssistantReply, messages: Messages, linkBase: string | null): string {
  if (isNoReply(reply.outcome)) return messages.ask.noReply[reply.outcome];
  const text = flattenMarkdown(reply.text, linkBase);
  const news = reply.sources
    .filter((source) => source.kind === 'news' && typeof source.url === 'string' && source.url !== '')
    .slice(0, MAX_NEWS_SOURCES);
  if (news.length === 0) return text;
  return `${text}\n\n${messages.ask.sources}\n${news.map((source) => `• ${source.label}\n${source.url}`).join('\n')}`;
}
