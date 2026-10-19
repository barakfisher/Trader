/**
 * Checking an agent's instructions against its settings (D176-D178).
 *
 * The page asks right after a save whose instructions are the user's own words;
 * the save itself never waits on a model. The AI service makes the one call and
 * answers `checked` or `skipped`; this route stores a `checked` result on the
 * agent with the fingerprint of what was judged - but only if the agent still
 * holds that, re-read after the call, so a save that landed meanwhile is never
 * labelled with the previous text's answer.
 *
 * Nothing here is ever an error the user has to handle: an unreachable AI
 * service is `skipped: failed`, like every other reason not to check.
 */

import type { Hono } from 'hono';

import type { InstructionsCheckResult, InstructionsConflict } from '@traders/shared';

import { logger } from '../../logger.js';
import { dismissInstructionsCheck, getAgent, saveInstructionsCheck } from '../../db/queries.js';
import { instructionsFingerprint } from '../../services/instructionsCheck.js';
import { currentUserId, type AppEnv } from '../app.js';
import { conflict, notFound } from '../errors.js';
import { agentIdFrom } from './agents.js';

const skipped = (reason: InstructionsCheckResult['reason']): InstructionsCheckResult => ({
  status: 'skipped',
  reason,
  conflicts: [],
});

export function registerInstructionsCheckRoutes(app: Hono<AppEnv>): void {
  app.post('/agents/:id/instructions-check', async (context) => {
    const userId = currentUserId(context);
    const agentId = agentIdFrom(context.req.param('id'));
    const agent = await getAgent(userId, agentId);
    if (!agent) throw notFound('agent not found');
    if (agent.is_primary) {
      throw conflict('primary_agent_is_passive', 'the real portfolio has no instructions to check');
    }
    if (!agent.persona?.trim()) return context.json(skipped('no_instructions'));

    const judged = instructionsFingerprint(agent);
    let answer;
    try {
      answer = await context.get('ai').checkMandate(agentId, userId, context.get('requestId'));
    } catch (error) {
      logger().warn({ err: error, agentId }, 'agents.instructions_check_unavailable');
      return context.json(skipped('failed'));
    }
    const conflicts: InstructionsConflict[] = answer.conflicts ?? [];
    if (answer.status === 'checked') {
      const now = await getAgent(userId, agentId);
      if (now && instructionsFingerprint(now) === judged) {
        await saveInstructionsCheck(userId, agentId, {
          fingerprint: judged,
          conflicts,
          checked_at: new Date().toISOString(),
          dismissed: false,
        });
      }
    }
    const body: InstructionsCheckResult = { status: answer.status, reason: answer.reason ?? null, conflicts };
    return context.json(body);
  });

  app.post('/agents/:id/instructions-check/dismiss', async (context) => {
    const userId = currentUserId(context);
    const agentId = agentIdFrom(context.req.param('id'));
    const agent = await getAgent(userId, agentId);
    if (!agent) throw notFound('agent not found');
    await dismissInstructionsCheck(userId, agentId, instructionsFingerprint(agent));
    return context.body(null, 204);
  });
}
