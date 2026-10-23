/**
 * A user's own model choice (D244, D282-D283): OpenRouter's list as the AI
 * service filtered it, what the user chose for Ask, for explanations and for
 * each agent, and the rule for what may be saved.
 *
 * The list and the resolution both live in the AI service, beside the provider
 * chain that applies them, so the list the page offers, the list a choice is
 * checked against and the model a call runs on are one list.
 */

import type { ModelChoicesResponse, ModelResolutionView } from '@traders/shared';
import { AiServiceError, type AiClient, type LlmListedModelsResponse, type UserLlmModelsResponse } from '@traders/shared/ai';
import { z } from 'zod';

import { ApiProblem, conflict, unprocessable, upstreamFailure } from '../http/errors.js';

/** Longer than any id OpenRouter lists; migration 0069's CHECK says the same. */
export const MODEL_ID_MAX_LENGTH = 200;

/** `{ model }`: an OpenRouter id, or null for "not chosen". The list is the authority on ids. */
/** An OpenRouter id's shape, as migration 0069's CHECK states it: anything else never reaches the list check. */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const modelChoiceSchema = z
  .object({ model: z.string().max(MODEL_ID_MAX_LENGTH).regex(MODEL_ID).nullable() })
  .strict();

/** The AI service's answer about models, or a 502 the page can say. */
export async function relayModels<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof AiServiceError)) throw error;
    throw upstreamFailure(error.status, 'The models could not be read.');
  }
}

function resolution(view: { saved: string | null; effective: string | null; fallback: boolean }): ModelResolutionView {
  return { saved: view.saved, effective: view.effective, fallback: view.fallback };
}

export function toModelChoices(listed: LlmListedModelsResponse, user: UserLlmModelsResponse): ModelChoicesResponse {
  const scope = (name: 'assistant' | 'explain'): ModelResolutionView => {
    const found = user.choices.find((choice) => choice.scope === name);
    return found ? resolution(found) : { saved: null, effective: null, fallback: false };
  };
  return {
    admin: user.admin,
    choosable: listed.choosable,
    live: listed.live,
    fallbackModel: listed.fallback_model,
    // The admin chooses on the Admin page; the list is not theirs to read here.
    models: user.admin
      ? []
      : listed.models.map((model) => ({
          id: model.id,
          name: model.name,
          promptUsdPerMtok: model.prompt_usd_per_mtok,
          completionUsdPerMtok: model.completion_usd_per_mtok,
          tested: model.tested,
          scanEstimateMicroUsd: model.scan_estimate_micro_usd,
        })),
    choices: { assistant: scope('assistant'), explain: scope('explain') },
    agents: user.agents.map((agent) => ({ agentId: agent.agent_id, name: agent.name, ...resolution(agent) })),
  };
}

export async function readModelChoices(ai: AiClient, userId: string, requestId?: string): Promise<ModelChoicesResponse> {
  const [listed, user] = await Promise.all([ai.llmListed(requestId), ai.userLlmModels(userId, requestId)]);
  return toModelChoices(listed, user);
}

/**
 * Why `model` may not be saved, or null when it may. Null (not chosen) always
 * may: it runs on the tested model. A model must be on the list as it is now;
 * one that has left it can stay saved (D283), but cannot be chosen anew.
 */
export function modelChoiceRefusal(listed: LlmListedModelsResponse, model: string | null): ApiProblem | null {
  if (!listed.choosable) {
    return conflict('models_not_choosable', 'models are chosen only when the installation runs on OpenRouter');
  }
  if (model === null) return null;
  if (!listed.models.some((offered) => offered.id === model)) {
    return unprocessable('model_not_offered', `${model} is not one of the offered models`, { model });
  }
  return null;
}
