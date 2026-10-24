/**
 * The Admin page's Keys tab (D251, D288): the AI service's provider keys, plus
 * the one this service holds - the Telegram bot token. Status, never values
 * (guideline 9); a last error is shown only after anything credential-shaped
 * in it is masked, because a channel's error can quote a URL with the token in it.
 */

import type { InstallationKeyView, InstallationKeysView, InstallationKeyTestView } from '@traders/shared';
import type { InstallationKeysResponse, InstallationKeyTestResponse } from '@traders/shared/ai';

/** The longest last error shown, as the AI service bounds its own. */
export const LAST_ERROR_MAX_CHARS = 300;

/** The Telegram bot token's row name: the variable it is set in. */
export const TELEGRAM_KEY = 'TELEGRAM_BOT_TOKEN';

/** The AI service's shapes (`installation_keys.py`), kept the same so the two mask alike. */
const SECRET_SHAPES = new RegExp(
  [
    'sk-[A-Za-z0-9_*.-]{4,}', // OpenAI and OpenRouter, including their own masked echo
    'Bearer\\s+\\S+',
    'bot\\d+:[A-Za-z0-9_-]+',
    '\\d{6,}:[A-Za-z0-9_-]{30,}', // a Telegram token, in a URL or bare
    '(?:api_?key|apikey|token|key)=[^&\\s]+', // a key in a query string
    '[A-Fa-f0-9]{32,}',
    '[A-Za-z0-9_-]{40,}',
  ].join('|'),
  'gi',
);

/**
 * The message with anything credential-shaped replaced, bounded for a table.
 * `values` are the configured secrets themselves, replaced word for word first;
 * shortened only after both, so a cut never leaves a fragment too short to catch.
 */
export function redact(message: string, ...values: (string | undefined)[]): string {
  let text = message;
  for (const value of values) {
    if (value && value.trim()) text = text.split(value.trim()).join('[redacted]');
  }
  const cleaned = text.replace(SECRET_SHAPES, '[redacted]');
  return cleaned.length <= LAST_ERROR_MAX_CHARS ? cleaned : `${cleaned.slice(0, LAST_ERROR_MAX_CHARS - 1)}…`;
}

export function toKeysView(
  ai: InstallationKeysResponse,
  telegram: { isSet: boolean; lastFailure: { at: Date; error: string | null } | null; token?: string },
): InstallationKeysView {
  const keys: InstallationKeyView[] = ai.keys.map((key) => ({
    name: key.name,
    provider: key.provider,
    isSet: key.is_set,
    serves: key.serves,
    unused: key.unused,
    testable: key.testable,
    lastError: key.last_error ? { at: key.last_error.at, message: redact(key.last_error.message) } : null,
  }));
  keys.push({
    name: TELEGRAM_KEY,
    provider: 'Telegram',
    isSet: telegram.isSet,
    serves: telegram.isSet ? ['telegram'] : [],
    unused: null,
    testable: telegram.isSet,
    lastError: telegram.lastFailure
      ? { at: telegram.lastFailure.at.toISOString(), message: redact(telegram.lastFailure.error ?? '', telegram.token) }
      : null,
  });
  return { keys };
}

export function toTestView(result: InstallationKeyTestResponse): InstallationKeyTestView {
  return { ok: result.ok, detail: result.detail === null ? null : redact(result.detail), checkedAt: result.checked_at };
}
