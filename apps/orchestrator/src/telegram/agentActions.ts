/**
 * A tap on a signed agent button (M11 A2, D275): Pause, Resume, a new schedule, or
 * Run after its confirm. Each goes through the service the agent page uses -
 * `agentControl.ts`, `manualScan.ts` - so a tap meets the click's refusals, and
 * the message is redrawn in place with what is now true (D270).
 *
 * **Run is the slow one.** A scan is a model call of up to a minute, and the
 * poller handles one update at a time, so the tap is answered at once - the
 * confirm becomes "scanning", with no buttons to tap twice - and the scan runs
 * on; its last run replaces the message when it ends. It counts against the
 * page's `agentScan` limit, at the same point the page counts it: before
 * anything is read (D257). Its proposals arrive as their own messages, with
 * Approve and Reject, as a scheduled scan's do.
 *
 * Nothing here throws to its caller (`updates.ts`).
 */

import type { AiClient } from '@traders/shared/ai';

import { getAgent, getUser } from '../db/queries.js';
import { ApiProblem } from '../http/errors.js';
import { userKey, type RateLimits } from '../http/rateLimits.js';
import { logger } from '../logger.js';
import { messagesFor, type Messages } from '../notify/messages.js';
import type { Notifier } from '../notify/notifier.js';
import { setAgentRunning, setAgentSchedule } from '../services/agentControl.js';
import { runManualScan } from '../services/manualScan.js';
import type { DecodedAgentAction } from './agentActionToken.js';
import { minutesOf } from './assistantQuestion.js';
import { renderView, runRefusal, type MenuDeps } from './menu.js';
import type { MenuView } from './menuData.js';

export interface AgentActionDeps extends MenuDeps {
  notifier: Notifier;
  rateLimits: RateLimits;
  ai: AiClient;
}

export interface AgentActionTap {
  callbackId: string;
  chatId: string;
  messageId: number;
  userId: string;
  language: string;
  decoded: DecodedAgentAction;
}

/** Draw `view` over the tapped message; `notice` goes above it. */
async function redraw(deps: AgentActionDeps, tap: AgentActionTap, view: MenuView, notice?: string): Promise<string | undefined> {
  const screen = await renderView(view, tap.userId, deps);
  const text = notice === undefined ? screen.text : `${notice}\n\n${screen.text}`;
  const edited = await deps.telegram.editWithButtons(tap.chatId, tap.messageId, text, screen.keyboard);
  if (!edited.delivered) {
    logger().warn({ chatId: tap.chatId, view: view.view, err: edited.error }, 'telegram.agent_action_edit_failed');
  }
  return screen.toast;
}

/** A service's refusal in the reader's words. */
function controlRefusal(error: ApiProblem, messages: Messages): string {
  if (error.code === 'agent_limit_reached') {
    const max = (error.details as { max?: unknown } | undefined)?.max;
    return typeof max === 'number' ? messages.menu.control.limitReached(max) : messages.menu.control.refused;
  }
  if (error.status === 404) return messages.menu.agents.gone;
  return messages.menu.control.refused;
}

function scanRefusal(error: unknown, messages: Messages): string {
  const code = error instanceof ApiProblem ? error.code : 'other';
  return (messages.menu.run.refusals as Record<string, string | undefined>)[code] ?? messages.menu.run.refusals.other;
}

/** Handle the tap. `done` settles when a started scan has ended (tests wait on it). */
export async function handleAgentActionTap(
  deps: AgentActionDeps,
  tap: AgentActionTap,
): Promise<{ done: Promise<void> }> {
  const messages = messagesFor(tap.language);
  const { payload, expired } = tap.decoded;
  const agentView: MenuView = { view: 'agent', agentId: payload.agentId };
  const answer = (text: string) => deps.telegram.answerCallback(tap.callbackId, text);
  const settled = { done: Promise.resolve() };

  try {
    if (expired) {
      // Drawn again with fresh buttons: what the user sees next is current.
      const view: MenuView = payload.action === 'schedule' ? { view: 'schedule', agentId: payload.agentId } : agentView;
      const toast = await redraw(deps, tap, view);
      await answer(toast ?? messages.menu.control.expired);
      return settled;
    }

    if (payload.action === 'pause' || payload.action === 'resume') {
      let toast: string;
      try {
        const user = await getUser(tap.userId);
        if (user === null) throw new ApiProblem(404, 'not_found', 'user not found');
        await setAgentRunning(user, payload.agentId, payload.action === 'pause' ? 'paused' : 'active');
        toast = payload.action === 'pause' ? messages.menu.control.pausedToast : messages.menu.control.resumedToast;
      } catch (error) {
        if (!(error instanceof ApiProblem)) throw error;
        toast = controlRefusal(error, messages);
      }
      const gone = await redraw(deps, tap, agentView);
      await answer(gone ?? toast);
      return settled;
    }

    if (payload.action === 'schedule') {
      let toast: string;
      try {
        await setAgentSchedule(tap.userId, payload.agentId, payload.schedule);
        toast = messages.menu.control.scheduleSavedToast;
      } catch (error) {
        if (!(error instanceof ApiProblem)) throw error;
        toast = controlRefusal(error, messages);
      }
      const gone = await redraw(deps, tap, { view: 'schedule', agentId: payload.agentId });
      await answer(gone ?? toast);
      return settled;
    }

    // Run: the page's limit first, counted before anything is read (D257).
    const limited = await deps.rateLimits.take('agentScan', userKey(tap.userId));
    if (limited !== null) {
      await answer(messages.rateLimited(minutesOf(limited.retryAfterSeconds)));
      return settled;
    }
    const agent = await getAgent(tap.userId, payload.agentId);
    const refusal = agent === null ? null : runRefusal(agent, messages);
    if (agent === null || agent.is_primary || agent.state === 'archived' || refusal !== null) {
      const gone = await redraw(deps, tap, agentView);
      await answer(gone ?? refusal ?? messages.menu.run.refusals.other);
      return settled;
    }

    // The confirm goes, so it cannot be tapped twice, and says what is happening.
    await deps.telegram.editWithButtons(tap.chatId, tap.messageId, messages.menu.run.running(agent.name), []);
    await answer(messages.menu.run.startedToast);
    const done = (async () => {
      try {
        await runManualScan(tap.userId, agent, { ai: deps.ai, notifier: deps.notifier });
        await redraw(deps, tap, { view: 'agentLog', agentId: agent.id });
      } catch (error) {
        logger().warn({ err: error, agentId: agent.id }, 'telegram.agent_scan_failed');
        await redraw(deps, tap, agentView, messages.menu.run.failed(scanRefusal(error, messages)));
      }
    })().catch((error: unknown) => {
      logger().error({ err: error, agentId: agent.id }, 'telegram.agent_scan_report_failed');
    });
    return { done };
  } catch (error) {
    logger().error({ err: error, action: payload.action }, 'telegram.agent_action_failed');
    await answer(messages.menu.unavailable);
    return settled;
  }
}
