/**
 * Finding episodes: a standing state is said when it crosses a band (decision 132).
 *
 * Drawdown and allocation drift are states. Dated by the day of their latest
 * price, they were written once a day for as long as they lasted: on kind, SMR's
 * one fall was "high drawdown" seven times in ten days. An **episode** is one
 * stretch of a subject being in a state; the scan is told the highest band each
 * open episode has written, and writes a state again only above it.
 *
 * This module keeps the episodes in step with what each scan saw:
 *
 * - a state the scan **wrote** opens its episode, or raises its band;
 * - an open episode whose subject the scan **looked at and found nothing for**
 *   has ended - it fell below the `info` band - and the next entry is new.
 *
 * "Looked at" matters in the same way as for proposal episodes: drift skipped on
 * a partly priced portfolio, or a holding without enough history, is "we did not
 * look", and closing on it would make the next scan that did look say it again.
 *
 * Not `proposalEpisodes.ts`, which decides whether to *ask* (decision 92). This
 * decides whether to *say*. Both run on every scan.
 */

import {
  closeFindingEpisodes,
  recordFindingEpisode,
  type OpenFindingEpisodeRow,
} from '../db/queries.js';
import type { SeenFinding } from './proposalEpisodes.js';

/** The finding kinds that are states. Mirrors `STATE_KINDS` in the AI service and 0049. */
export const STATE_KINDS: ReadonlySet<string> = new Set(['drawdown', 'allocation_drift']);

/** What the scan reported about which rules ran, from its stats. */
export interface ScanCoverage {
  /** Why allocation drift did not run; absent when it did. */
  driftSkippedReason?: string | null;
  /** Holdings whose history was too short for any instrument rule to run. */
  insufficientHistory?: string[];
}

/** A newly stored observation, in the shape `insertObservations` returns it. */
export interface WrittenFinding {
  id: string;
  kind: string;
  severity: string;
  subject_ref: string | null;
}

/** Whether the rule behind `episode` ran over its subject in this scan. */
export function wasMeasured(episode: OpenFindingEpisodeRow, coverage: ScanCoverage): boolean {
  if (episode.kind === 'allocation_drift') return !coverage.driftSkippedReason;
  if (episode.kind === 'drawdown') {
    const symbol = episode.subject_ref.replace(/^instrument:/, '');
    return !(coverage.insufficientHistory ?? []).includes(symbol);
  }
  // A kind this module does not know is never closed: closing re-arms the
  // finding, so an unknown errs towards quiet.
  return false;
}

/** The open episodes this scan shows to have ended. */
export function endedEpisodes(
  open: OpenFindingEpisodeRow[],
  seen: SeenFinding[],
  coverage: ScanCoverage,
): OpenFindingEpisodeRow[] {
  const present = new Set(seen.map((finding) => `${finding.kind}|${finding.subject_ref}`));
  return open.filter(
    (episode) =>
      !present.has(`${episode.kind}|${episode.subject_ref}`) && wasMeasured(episode, coverage),
  );
}

/** Record what this scan wrote and close what it saw end. Returns how many ended. */
export async function settleFindingEpisodes(
  userId: string,
  agentId: string,
  open: OpenFindingEpisodeRow[],
  written: WrittenFinding[],
  seen: SeenFinding[],
  coverage: ScanCoverage,
): Promise<number> {
  for (const finding of written) {
    if (!STATE_KINDS.has(finding.kind) || finding.subject_ref === null) continue;
    await recordFindingEpisode({
      userId,
      agentId,
      kind: finding.kind,
      subjectRef: finding.subject_ref,
      severity: finding.severity,
      observationId: finding.id,
    });
  }
  const ended = endedEpisodes(open, seen, coverage);
  return closeFindingEpisodes(
    userId,
    ended.map((episode) => episode.id),
  );
}
