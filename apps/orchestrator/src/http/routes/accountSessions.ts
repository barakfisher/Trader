/**
 * The signed-in user's devices (D261, D296): the list, signing one other
 * device out, and signing out every other device.
 *
 * Under `/account`, so the session gate covers them - signed in, and not
 * holding a one-time password that must be changed first (D162). This device
 * is never ended here: the menu's *Sign out* does that (D296), and refusing it
 * here keeps a list click from landing on the login screen.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import type { SessionDeviceList, SignOutOthersResponse } from '@traders/shared';

import { deleteOtherSessions, deleteSession, listSessions } from '../../db/queries.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, notFound, unauthorized } from '../errors.js';
import { describeSession } from '../sessions.js';

const sessionIdSchema = z.string().uuid();

export function registerAccountSessionRoutes(app: Hono<AppEnv>): void {
  app.get('/account/sessions', async (context) => {
    const userId = currentUserId(context);
    const sessionId = context.get('sessionId');
    const rows = await listSessions(userId);
    const body: SessionDeviceList = { sessions: rows.map((row) => describeSession(row, sessionId)) };
    return context.json(body);
  });

  /**
   * End one other device's session. Someone else's id, or one that does not
   * exist, is "not found" - never which.
   */
  app.delete('/account/sessions/:id', async (context) => {
    const userId = currentUserId(context);
    const parsed = sessionIdSchema.safeParse(context.req.param('id'));
    if (!parsed.success) throw notFound('no such session');
    // Postgres compares uuids without regard to case; so must this.
    if (parsed.data.toLowerCase() === context.get('sessionId')) {
      throw badRequest('current_session', 'this device signs out from the menu, not from the list');
    }
    if (!(await deleteSession(userId, parsed.data))) throw notFound('no such session');
    return context.body(null, 204);
  });

  /** End every session but this one (D296). */
  app.post('/account/sessions/sign-out-others', async (context) => {
    const userId = currentUserId(context);
    const sessionId = context.get('sessionId');
    if (!sessionId) throw unauthorized();
    const body: SignOutOthersResponse = { ended: await deleteOtherSessions(userId, sessionId) };
    return context.json(body);
  });
}
