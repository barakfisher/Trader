import { query, transaction } from '../pool.js';

export interface TargetWeightRow {
  instrument_id: string;
  symbol: string;
  name: string | null;
  /** `numeric(6, 4)` read as text: a weight never passes through a float. */
  weight: string;
}

export interface TargetWeightInput {
  instrumentId: string;
  weight: string;
}

export function listTargetWeights(userId: string): Promise<TargetWeightRow[]> {
  return query<TargetWeightRow>(
    `SELECT t.instrument_id, t.weight::text AS weight, i.symbol, i.name
       FROM target_weights t
       JOIN instruments i ON i.id = t.instrument_id
      WHERE t.user_id = $1
      ORDER BY i.symbol`,
    [userId],
  );
}

/**
 * Replace the user's entire set of target weights in one transaction.
 *
 * Replace, not patch: a set of weights is a single statement about how the
 * portfolio was meant to be shaped, and the constraint that matters (they sum to
 * at most the whole portfolio) is a property of the set, not of any one row. A
 * partial update can therefore leave behind a combination the user never chose,
 * and the drift rule would then report against it as if they had.
 *
 * An empty set is a legitimate input: it clears the targets, and the scan goes
 * back to reporting that drift has nothing to compare against.
 */
export async function replaceTargetWeights(
  userId: string,
  targets: TargetWeightInput[],
): Promise<number> {
  return transaction(async (client) => {
    await client.query('DELETE FROM target_weights WHERE user_id = $1', [userId]);
    if (targets.length === 0) return 0;

    const values: string[] = [];
    const params: unknown[] = [userId];
    targets.forEach((target) => {
      params.push(target.instrumentId, target.weight);
      values.push(`($1, $${params.length - 1}, $${params.length}::numeric)`);
    });
    await client.query(
      `INSERT INTO target_weights (user_id, instrument_id, weight) VALUES ${values.join(', ')}`,
      params,
    );
    return targets.length;
  });
}
