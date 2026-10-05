/**
 * Commit a previously previewed import.
 *
 * The whole commit runs in one transaction so a failure halfway through cannot
 * leave the portfolio half-replaced. Rows the user did not select, and rows that
 * are still unresolved, are reported as skipped rather than guessed at.
 */

import type { ImportCommitRequest, ImportCommitResult, ImportPreview, ImportRow } from '@traders/shared';

import { deleteAllHoldings, transaction, upsertHolding, upsertInstrument } from '../db/queries.js';
import { logger } from '../logger.js';

export async function commitImport(
  userId: string,
  agentId: string,
  preview: ImportPreview,
  request: ImportCommitRequest,
): Promise<ImportCommitResult> {
  const selected = new Set(request.lines);
  const overrides = request.symbolOverrides ?? {};

  const result: ImportCommitResult = { created: 0, updated: 0, skipped: 0, failed: [] };
  const importable: { row: ImportRow; symbol: string; instrument: NonNullable<ImportRow['resolvedInstrument']> }[] = [];

  for (const row of preview.rows) {
    if (!selected.has(row.line)) {
      result.skipped += 1;
      continue;
    }
    if (row.quantity === null) {
      result.failed.push({ line: row.line, message: 'row has no valid quantity' });
      continue;
    }

    const overrideSymbol = overrides[row.line]?.toUpperCase();
    const instrument = overrideSymbol
      ? (row.candidates.find((candidate) => candidate.symbol.toUpperCase() === overrideSymbol) ??
        (row.resolvedInstrument?.symbol.toUpperCase() === overrideSymbol ? row.resolvedInstrument : null))
      : row.resolvedInstrument;

    if (!instrument) {
      result.failed.push({
        line: row.line,
        message: overrideSymbol
          ? `"${overrideSymbol}" is not one of the candidates offered for this row`
          : 'row has no resolved instrument',
      });
      continue;
    }
    importable.push({ row, symbol: instrument.symbol, instrument });
  }

  if (importable.length === 0 && request.mode !== 'replace') {
    return result;
  }

  await transaction(async (client) => {
    if (request.mode === 'replace') {
      const removed = await deleteAllHoldings(userId, client);
      logger().info({ removed }, 'import replace mode cleared existing holdings');
    }

    for (const item of importable) {
      const instrumentRow = await upsertInstrument(
        {
          symbol: item.instrument.symbol,
          name: item.instrument.name,
          assetClass: item.instrument.assetClass,
          exchange: item.instrument.exchange,
          currency: item.instrument.currency,
        },
        client,
      );
      const upserted = await upsertHolding(
        {
          userId,
          agentId,
          instrumentId: instrumentRow.id,
          quantity: item.row.quantity as string,
          costBasisMinor: item.row.costBasisMinor,
          currency: item.row.currency,
          openedAt: item.row.openedAt,
          notes: item.row.notes,
        },
        client,
      );
      if (upserted.inserted) result.created += 1;
      else result.updated += 1;
    }
  });

  return result;
}
