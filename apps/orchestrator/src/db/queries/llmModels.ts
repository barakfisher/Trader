import type { LlmScope } from '@traders/shared';

import { query } from '../pool.js';

/**
 * Record the model chosen for `scope` (D43). One row per scope, replaced on
 * every choice; the AI service reads it on its next call. The admin gate has
 * already written the `admin_audit` row by the time this runs (decision 84).
 */
export async function chooseLlmModel(scope: LlmScope, model: string, adminUserId: string): Promise<void> {
  await query(
    `INSERT INTO llm_model_choices (scope, model, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (scope) DO UPDATE
       SET model = EXCLUDED.model, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [scope, model, adminUserId],
  );
}
