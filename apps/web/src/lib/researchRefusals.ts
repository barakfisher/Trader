import { RESEARCH_REFUSALS } from '@traders/shared';

import { ApiRequestError, errorMessage } from '../api/client.ts';
import { t } from '../i18n/index.ts';

/** Refusals a research start is said with in the reader's words: research's own, the payer's, and no model. */
const SAID_REFUSALS = [
  ...RESEARCH_REFUSALS,
  'own_key_required',
  'own_key_failed',
  'safety_limit_reached',
  'no_model',
] as const;
type SaidRefusal = (typeof SAID_REFUSALS)[number];

/**
 * A refused research start in the reader's words: a known refusal from the
 * catalogue, else the server's. The research page and a holding row's
 * "Research this stock" (D369) say the same refusal the same way.
 */
export function researchRefusalText(error: Error | null): string | null {
  if (error === null) return null;
  return error instanceof ApiRequestError && (SAID_REFUSALS as readonly string[]).includes(error.code)
    ? t(`research.refusals.${error.code as SaidRefusal}`)
    : errorMessage(error, t('research.startFailed'));
}
