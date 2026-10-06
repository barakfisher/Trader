/**
 * The Admin page's model pickers (D43, D44): the AI service's catalogue, prices
 * and estimates in this API's shape, and the rule for what may be chosen.
 *
 * The catalogue lives in the AI service beside the prices and the budget guard
 * it must agree with; this module only asks it, so the list the page offers and
 * the list a choice is checked against are one list.
 */

import type { AdminLlmModelsResponse, LlmScope } from '@traders/shared';
import type { LlmModelsResponse } from '@traders/shared/ai';

export const LLM_SCOPES: readonly LlmScope[] = ['explain', 'agent'];

export function isLlmScope(value: string): value is LlmScope {
  return (LLM_SCOPES as readonly string[]).includes(value);
}

export function toAdminLlmModels(body: LlmModelsResponse): AdminLlmModelsResponse {
  return {
    provider: body.provider,
    choosable: body.choosable,
    configuredModel: body.configured_model,
    choices: body.choices.map((choice) => ({
      scope: choice.scope,
      chosen: choice.chosen,
      effective: choice.effective,
    })),
    models: body.models.map((model) => ({
      id: model.id,
      label: model.label,
      promptUsdPerMtok: model.prompt_usd_per_mtok,
      completionUsdPerMtok: model.completion_usd_per_mtok,
      supportsTools: model.supports_tools,
      free: model.free,
      scopes: model.scopes,
      estimates: {
        explain: {
          dailyMicroUsd: model.explain_estimate.daily_micro_usd,
          monthlyMicroUsd: model.explain_estimate.monthly_micro_usd,
        },
        agent: model.agent_estimate
          ? {
              dailyMicroUsd: model.agent_estimate.daily_micro_usd,
              monthlyMicroUsd: model.agent_estimate.monthly_micro_usd,
            }
          : null,
      },
      scanEstimateMicroUsd: model.scan_estimate_micro_usd,
    })),
    explainBasis: {
      windowDays: body.explain_basis.window_days,
      promptTokensPerDay: body.explain_basis.prompt_tokens_per_day,
      completionTokensPerDay: body.explain_basis.completion_tokens_per_day,
    },
    agentBasis: {
      scanningAgents: body.agent_basis.scanning_agents,
      scansPerDay: body.agent_basis.scans_per_day,
      promptTokensPerScan: body.agent_basis.prompt_tokens_per_scan,
      completionTokensPerScan: body.agent_basis.completion_tokens_per_scan,
      source: body.agent_basis.source,
    },
    credits: body.credits
      ? {
          purchasedUsd: body.credits.purchased_usd,
          usedUsd: body.credits.used_usd,
          remainingUsd: body.credits.remaining_usd,
        }
      : null,
  };
}

/** Why `model` may not be chosen for `scope`, or null when it may. */
export function choiceRefusal(
  catalogue: LlmModelsResponse,
  scope: LlmScope,
  model: string,
): { code: string; message: string } | null {
  if (!catalogue.choosable) {
    return {
      code: 'models_not_choosable',
      message: `models are chosen here only with LLM_PROVIDER=openrouter (this installation uses ${catalogue.provider})`,
    };
  }
  const offered = catalogue.models.find((candidate) => candidate.id === model);
  if (!offered) return { code: 'model_not_offered', message: `${model} is not one of the offered models` };
  if (!offered.scopes.includes(scope)) {
    return {
      code: 'model_not_offered_for_scope',
      message: `${model} cannot be chosen for ${scope}: an agent needs a billed model that calls tools`,
    };
  }
  return null;
}
