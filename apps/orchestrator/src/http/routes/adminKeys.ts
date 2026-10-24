/**
 * `GET /admin/keys` and `POST /admin/keys/:name/test` (D251, D288): the Keys
 * tab. Behind the admin gate like every `/admin/*` route, which also audits the
 * test (decision 84). Status only; rotating a key stays an edit and a redeploy.
 */

import type { Hono } from 'hono';
import type { InstallationKeysView, InstallationKeyTestView } from '@traders/shared';
import { AiServiceError } from '@traders/shared/ai';

import { lastTelegramFailure } from '../../db/queries.js';
import { TelegramNotifier } from '../../telegram/client.js';
import { TELEGRAM_KEY, redact, toKeysView, toTestView } from '../../services/installationKeys.js';
import type { AppEnv } from '../app.js';
import { aiRefusal, conflict, notFound, upstreamFailure } from '../errors.js';

/** The variable names a test may name: upper-case words, as `.env` writes them. */
const KEY_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

export function registerAdminKeysRoutes(app: Hono<AppEnv>): void {
  app.get('/admin/keys', async (context) => {
    let ai;
    try {
      ai = await context.get('ai').installationKeys(context.get('requestId'));
    } catch (error) {
      if (error instanceof AiServiceError) throw upstreamFailure(error.status, 'The keys could not be read.');
      throw error;
    }
    const body: InstallationKeysView = toKeysView(ai, {
      isSet: Boolean(context.get('config').TELEGRAM_BOT_TOKEN),
      lastFailure: await lastTelegramFailure(),
      token: context.get('config').TELEGRAM_BOT_TOKEN,
    });
    return context.json(body);
  });

  app.post('/admin/keys/:name/test', async (context) => {
    const name = context.req.param('name');
    if (!KEY_NAME.test(name)) throw notFound('no such key');
    if (name === TELEGRAM_KEY) {
      const notifier = context.get('notifier');
      if (!(notifier instanceof TelegramNotifier)) {
        throw conflict('key_not_testable', 'the Telegram bot token is not set');
      }
      const result = await notifier.checkToken();
      const body: InstallationKeyTestView = {
        ok: result.delivered,
        detail: result.delivered ? null : redact(result.error ?? '', context.get('config').TELEGRAM_BOT_TOKEN),
        checkedAt: new Date().toISOString(),
      };
      return context.json(body);
    }
    try {
      const body: InstallationKeyTestView = toTestView(
        await context.get('ai').testInstallationKey(name, context.get('requestId')),
      );
      return context.json(body);
    } catch (error) {
      if (!(error instanceof AiServiceError)) throw error;
      const refusal = aiRefusal(error.body);
      if (error.status === 404) throw notFound('no such key');
      if (error.status === 409 && refusal) throw conflict(refusal.code, refusal.message);
      throw upstreamFailure(error.status, 'The key could not be tested.');
    }
  });
}
