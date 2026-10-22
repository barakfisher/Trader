/**
 * The list Telegram shows when the user types `/` (M11 slice A1, D271).
 *
 * Set with `setMyCommands` at every start: the call replaces the whole list,
 * so running it again is free, and a list that drifted from the code - a
 * command added here and never registered - heals on the next deploy.
 *
 * **Telegram chooses the list by the phone's language**, not by the language
 * the user picked in Settings: English is the default list and Hebrew is
 * registered for `language_code: he`. A user whose phone and Settings
 * disagree sees the list in one language and the replies in the other. That
 * is accepted: the alternative - a list per chat, set when the language
 * changes - is a call per user for a menu of nine words.
 *
 * `/start` is left out: it does something only with the one-time link from
 * Settings, and Telegram shows its own Start button to a chat that has never
 * used the bot. Typed bare in a bound chat it shows `/help` (`updates.ts`).
 */

import type { UiLanguage } from '@traders/shared';

import { logger } from '../logger.js';
import { MESSAGES } from '../notify/messages.js';
import type { TelegramNotifier } from './client.js';

export const BOT_COMMANDS = [
  'help',
  'portfolio',
  'agents',
  'pending',
  'status',
  'mute',
  'unmute',
  'new',
  'stop',
] as const;

export type BotCommand = (typeof BOT_COMMANDS)[number];

/** Telegram's limit on a command's description. */
export const MAX_COMMAND_DESCRIPTION_CHARS = 256;

/** The `commands` array for one language, in menu order. */
export function commandListFor(language: UiLanguage): { command: BotCommand; description: string }[] {
  return BOT_COMMANDS.map((command) => ({ command, description: MESSAGES[language].menu.commands[command] }));
}

/**
 * Register the list in every interface language. Never throws: a bot whose
 * menu could not be set still answers every command typed in full.
 */
export async function registerBotCommands(telegram: TelegramNotifier): Promise<void> {
  const languages = Object.keys(MESSAGES) as UiLanguage[];
  for (const language of languages) {
    // English is the default list, shown to every phone language without its own.
    const result = await telegram.setCommands(commandListFor(language), language === 'en' ? null : language);
    if (result.delivered) {
      logger().info({ language }, 'telegram.commands_registered');
    } else {
      logger().warn({ language, err: result.error }, 'telegram.commands_not_registered');
    }
  }
}
