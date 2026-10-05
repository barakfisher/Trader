/**
 * Proposal episodes: a standing finding is asked about once (decision 92).
 *
 * An observation's `dedupe_key` changes with each day's valuation, which is
 * right for the feed - "still drifted" is worth saying daily - and wrong for the
 * inbox. Measured on 2026-10-01: the BTC-USD drift sat at 0.149-0.153 all week on
 * the 0.15 "high" line and was proposed seven days running, once twenty minutes
 * after the user approved it. Approval writes to the virtual ledger, so it never
 * moves the drift; and hovering on the line crossed it several times a day.
 *
 * So the question belongs to an **episode**, not an observation. Once asked
 * about a subject, the scan does not ask again - whatever the answer, including
 * none - until one of these:
 *
 * - **resolved**: a scan in which the rule ran sees the subject below the band
 *   beneath the proposal floor (for a `high` floor, below `notable`). A band of
 *   hysteresis, so hovering on the floor is not a resolution; the next return
 *   above the floor is a new episode.
 * - **worsened**: the magnitude has grown by one band (the floor's threshold
 *   minus the one beneath it) beyond what the question was asked at.
 * - **reversed**: the sign changed - overweight became underweight.
 *
 * Every limit is read from the thresholds the finding itself carries, so there
 * is no number here to tune.
 */

import {
  claimEpisode,
  closeEpisodes,
  listOpenEpisodes,
  type OpenEpisodeRow,
} from '../db/queries.js';
import { SEVERITY_RANK } from './proposals.js';

/** A finding the scan made, new or already known (`stats.seen`). */
export interface SeenFinding {
  kind: string;
  subject_ref: string;
  severity: string;
}

/** A finding about to become a proposal, in the shape the scan holds it. */
export interface EpisodeCandidate {
  id: string;
  kind: string;
  severity: string;
  subjectRef: string | null;
  evidence: unknown;
}

/**
 * The kinds that have episodes, and how to read one from a finding's evidence.
 *
 * Mirrors `PROPOSABLE_KINDS`: allocation drift is the only proposable kind, and
 * a new proposable kind without an entry here keeps the old behaviour (one
 * question per observation) rather than being silenced by a rule written for
 * something else.
 */
const EPISODE_KINDS: Record<
  string,
  { magnitude: (evidence: Record<string, unknown>) => unknown; bands: string }
> = {
  allocation_drift: { magnitude: (evidence) => evidence.drift, bands: 'thresholds_weight' },
};

const SCALE = 18;

/** A decimal string as an integer at 18 places. Never a float (guideline 3's spirit). */
export function toFixed18(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`not a decimal: ${value}`);
  const [, sign, whole, fraction = ''] = match;
  const digits = BigInt(whole! + fraction.padEnd(SCALE, '0').slice(0, SCALE));
  return sign === '-' ? -digits : digits;
}

/** A JSON number or decimal string as `toFixed18` reads it, or null if it is neither. */
function decimalOf(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isFinite(value)) return toFixed18(String(value));
  if (typeof value === 'string') {
    try {
      return toFixed18(value);
    } catch {
      return null;
    }
  }
  return null;
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

const SEVERITY_BY_RANK = Object.fromEntries(
  Object.entries(SEVERITY_RANK).map(([name, rank]) => [rank, name]),
) as Record<number, string>;

/** Whether a subject's current severity (absent: no finding) ends its episode. */
export function isResolved(severity: string | undefined, floor: string): boolean {
  if (severity === undefined) return true;
  const rank = SEVERITY_RANK[severity];
  const floorRank = SEVERITY_RANK[floor];
  // A severity we cannot read resolves nothing: closing an episode re-arms the
  // question, so an unknown must err towards quiet.
  if (rank === undefined || floorRank === undefined) return false;
  return rank < floorRank - 1;
}

/** One band at the floor: its threshold minus the one beneath (or zero). */
export function bandStep(bands: unknown, floor: string): bigint | null {
  if (typeof bands !== 'object' || bands === null) return null;
  const table = bands as Record<string, unknown>;
  const floorRank = SEVERITY_RANK[floor];
  if (floorRank === undefined) return null;
  const top = decimalOf(table[floor]);
  if (top === null) return null;
  const beneath = SEVERITY_BY_RANK[floorRank - 1];
  const bottom = beneath === undefined ? 0n : decimalOf(table[beneath]);
  return bottom === null ? null : top - bottom;
}

export type EpisodeVerdict = 'held' | 'worsened' | 'reversed';

/** Compare a finding with the figure its open episode was asked at. */
export function compareWithAsked(asked: bigint, now: bigint, step: bigint): EpisodeVerdict {
  if (asked !== 0n && now !== 0n && asked < 0n !== now < 0n) return 'reversed';
  if (abs(now) >= abs(asked) + step) return 'worsened';
  return 'held';
}

/**
 * Close the episodes this scan shows to be resolved.
 *
 * `ruleRan` must be false when the rule behind the kind declined to run (drift
 * on a partly priced portfolio): absence from that scan is "we did not look",
 * not "it went away", and closing on it would re-ask on the next scan that did.
 */
export async function settleEpisodes(
  userId: string,
  agentId: string,
  seen: SeenFinding[],
  ruleRan: Record<string, boolean>,
  floor: string,
): Promise<number> {
  let closed = 0;
  for (const kind of Object.keys(EPISODE_KINDS)) {
    if (!ruleRan[kind]) continue;
    const open = await listOpenEpisodes(userId, agentId, kind);
    if (open.length === 0) continue;
    const current = new Map<string, string>();
    for (const finding of seen) {
      if (finding.kind !== kind) continue;
      // The strongest severity seen for the subject is the one that counts.
      const previous = current.get(finding.subject_ref);
      if (
        previous === undefined ||
        (SEVERITY_RANK[finding.severity] ?? -1) > (SEVERITY_RANK[previous] ?? -1)
      ) {
        current.set(finding.subject_ref, finding.severity);
      }
    }
    const resolved = open
      .filter((episode) => isResolved(current.get(episode.subject_ref), floor))
      .map((episode) => episode.id);
    closed += await closeEpisodes(userId, resolved, 'resolved');
  }
  return closed;
}

/**
 * The candidates that may become a proposal now, each holding its episode.
 *
 * A candidate with no episode policy, or whose evidence cannot be read, passes
 * through unchanged: the old behaviour, which over-asks, is the safe failure.
 */
export async function admitCandidates<T extends EpisodeCandidate>(
  userId: string,
  agentId: string,
  candidates: T[],
  floor: string,
): Promise<{ admitted: T[]; held: number }> {
  const admitted: T[] = [];
  let held = 0;
  const openByKind = new Map<string, Map<string, OpenEpisodeRow>>();

  for (const candidate of candidates) {
    const policy = EPISODE_KINDS[candidate.kind];
    const evidence =
      typeof candidate.evidence === 'object' && candidate.evidence !== null
        ? (candidate.evidence as Record<string, unknown>)
        : null;
    const magnitudeValue = policy && evidence ? policy.magnitude(evidence) : undefined;
    const magnitude = decimalOf(magnitudeValue);
    const step = policy && evidence ? bandStep(evidence[policy.bands], floor) : null;
    if (!policy || candidate.subjectRef === null || magnitude === null || step === null) {
      admitted.push(candidate);
      continue;
    }

    let open = openByKind.get(candidate.kind);
    if (!open) {
      open = new Map(
        (await listOpenEpisodes(userId, agentId, candidate.kind)).map((row) => [row.subject_ref, row]),
      );
      openByKind.set(candidate.kind, open);
    }

    const episode = open.get(candidate.subjectRef);
    if (episode) {
      const verdict = compareWithAsked(toFixed18(episode.asked_magnitude), magnitude, step);
      if (verdict === 'held') {
        held += 1;
        continue;
      }
      await closeEpisodes(userId, [episode.id], verdict);
      open.delete(candidate.subjectRef);
    }

    const claimed = await claimEpisode({
      userId,
      observationKind: candidate.kind,
      subjectRef: candidate.subjectRef,
      observationId: candidate.id,
      askedMagnitude: String(magnitudeValue),
    });
    if (claimed === null) {
      // A concurrent scan opened it first, and asked.
      held += 1;
      continue;
    }
    open.set(candidate.subjectRef, {
      id: claimed,
      subject_ref: candidate.subjectRef,
      asked_magnitude: String(magnitudeValue),
    });
    admitted.push(candidate);
  }
  return { admitted, held };
}
