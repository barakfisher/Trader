/**
 * The contradiction check's orchestrator side (D176-D178): what it judged, and
 * whether its result still applies.
 *
 * A result is stored with a fingerprint of the instructions and the mandate the
 * model read. It is shown only while the agent still holds exactly those - a
 * change to either makes it say nothing, and the next qualifying save checks
 * again - and until the user dismisses it.
 */

import { createHash } from 'node:crypto';

import { CONFLICT_SETTINGS, type ConflictSetting, type InstructionsConflict } from '@traders/shared';

import { MANDATE_COLUMNS, type AgentRow } from '../db/queries/agents.js';

/** Of the trimmed instructions and every mandate column, in one fixed order. */
export function instructionsFingerprint(row: AgentRow): string {
  const mandate = MANDATE_COLUMNS.map((column) => row[column] ?? null);
  return createHash('sha256')
    .update(JSON.stringify([row.persona?.trim() ?? '', mandate]))
    .digest('hex');
}

const isSetting = (value: string): value is ConflictSetting => (CONFLICT_SETTINGS as readonly string[]).includes(value);

/** The stored conflicts, while they still describe this agent; null otherwise. */
export function currentConflicts(row: AgentRow): InstructionsConflict[] | null {
  const check = row.instructions_check;
  if (!check || check.dismissed || check.conflicts.length === 0) return null;
  if (check.fingerprint !== instructionsFingerprint(row)) return null;
  const conflicts = check.conflicts.flatMap((conflict) =>
    isSetting(conflict.setting) ? [{ setting: conflict.setting, quote: conflict.quote }] : [],
  );
  return conflicts.length > 0 ? conflicts : null;
}
