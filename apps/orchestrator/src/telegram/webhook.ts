/**
 * The Telegram webhook and the "Connect Telegram" endpoint (FLOWS.md F4).
 *
 * This is a **public, unauthenticated endpoint** - anybody who learns the URL
 * can post to it - so nothing here trusts its input. The check that belongs to
 * this transport is **the secret header**: Telegram echoes
 * `X-Telegram-Bot-Api-Secret-Token` on every delivery, and a request without it
 * never reaches the parser. The chat binding and the signed callback are
 * checked in `updates.ts`, which the long-poll transport shares.
 *
 * **The webhook always answers 200** once the secret checks out. Telegram
 * retries anything else, and a retry re-delivers a callback whose nonce is
 * already spent - so a 500 here converts one failure into a loop.
 *
 * **Nothing registers this webhook yet.** `setWebhook` needs a public HTTPS
 * URL, which arrives with M7's ingress; until then `TelegramPoller` pulls the
 * same updates and hands them to the same handler.
 */

import type { Hono } from 'hono';

import { findTelegramBindingByUser } from '../db/queries.js';
import { logger } from '../logger.js';
import { currentUserId, type AppEnv } from '../http/app.js';
import { encodeBindToken } from './bindToken.js';
import { handleTelegramUpdate } from './updates.js';

export {
  DEFAULT_MUTE_HOURS,
  MAX_MUTE_HOURS,
  TELEGRAM_SNOOZE_HOURS,
  parseMuteDuration,
} from './updates.js';

export function registerTelegramRoutes(app: Hono<AppEnv>): void {
  /**
   * Mint a connect link. Authenticated, because it names the user it binds -
   * this is the one Telegram endpoint that is *not* public, and it is the only
   * place a token is created.
   */
  app.post('/telegram/bind-token', async (context) => {
    const config = context.get('config');
    if (!config.TELEGRAM_BOT_USERNAME || !config.TELEGRAM_SIGNING_SECRET) {
      return context.json(
        { error: 'telegram_not_configured', message: 'this installation has no Telegram bot' },
        503,
      );
    }
    const { token, payload } = encodeBindToken(
      currentUserId(context),
      // The signing key, never the webhook secret. The webhook secret is shared
      // with Telegram and rides in every inbound header; signing a connect link
      // with it would make a leak of that shared value into the ability to bind
      // an attacker's chat to this account.
      config.TELEGRAM_SIGNING_SECRET,
    );
    return context.json({
      // The deep link, ready to render as a button or a QR code.
      url: `https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=${token}`,
      expiresAt: payload.expiresAt.toISOString(),
    });
  });

  /** Whether this user has a chat connected, for the settings page to show. */
  app.get('/telegram/binding', async (context) => {
    const binding = await findTelegramBindingByUser(currentUserId(context));
    return context.json({
      connected: binding !== null,
      username: binding?.username ?? null,
      boundAt: binding?.bound_at.toISOString() ?? null,
    });
  });

  app.post('/telegram/webhook', async (context) => {
    const config = context.get('config');
    const secret = config.TELEGRAM_WEBHOOK_SECRET;

    // Check one. Compared before the body is even read: an unauthenticated
    // caller must not be able to make us parse anything.
    if (!secret || context.req.header('x-telegram-bot-api-secret-token') !== secret) {
      logger().warn('telegram.webhook_bad_secret');
      // 401 rather than a silent 200: this is not Telegram, so there is no
      // retry storm to avoid, and a caller guessing the URL learns nothing from
      // a status they could have got by guessing the secret too.
      return context.json({ ok: false }, 401);
    }

    // Always 200 from here. The handler never throws, and anything else would
    // be retried by Telegram - re-delivering a callback whose nonce is spent,
    // so one failure would become a loop.
    await handleTelegramUpdate(
      { config, notifier: context.get('notifier') },
      await context.req.json().catch(() => null),
    );
    return context.json({ ok: true });
  });
}

