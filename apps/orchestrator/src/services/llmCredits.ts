/**
 * The installation's provider balance on the Admin page (D44, D360): what is
 * left of the credit that pays the admin's calls. The models themselves are
 * chosen per user, the admin included, on the agent pages and in Settings.
 */

import type { AdminLlmCreditsResponse } from '@traders/shared';
import type { LlmCreditsResponse } from '@traders/shared/ai';

export function toAdminLlmCredits(body: LlmCreditsResponse): AdminLlmCreditsResponse {
  return {
    provider: body.provider,
    credits: body.credits
      ? {
          purchasedUsd: body.credits.purchased_usd,
          usedUsd: body.credits.used_usd,
          remainingUsd: body.credits.remaining_usd,
        }
      : null,
  };
}
