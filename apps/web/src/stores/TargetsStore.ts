import { makeAutoObservable, runInAction } from 'mobx';

import type { ObservationSeverity, TargetWeight, TargetsUpdateResponse } from '@traders/shared';

import { ApiRequestError, api } from '../api/client.ts';
import {
  WEIGHT_UNITS_PER_PORTFOLIO,
  actualWeightUnits,
  driftSeverity,
  percentToUnits,
  unitsToPercent,
  unitsToWeight,
  weightToUnits,
} from '../lib/targetWeights.ts';
import { queryKeys } from '../queries/queryKeys.ts';
import { t } from '../i18n/index.ts';
import type { RootStore } from './RootStore.ts';

/** One line of the form: what is held, what was meant to be, and the gap. */
export interface TargetRow {
  symbol: string;
  name: string | null;
  /** False for a target on something sold out of, which is a normal thing to keep. */
  held: boolean;
  /**
   * The current weight in integer units, or null when the holding is unpriced
   * and therefore has no weight — never zero, which would render an
   * infrastructure failure as a financial fact (guideline 7).
   */
  actualUnits: number | null;
  /** Exactly what is in the box, including the empty string and mid-edit text. */
  targetText: string;
  /** The box parsed, or null when it is empty or not yet a number. */
  targetUnits: number | null;
  /** Null unless both sides of the subtraction exist. */
  driftUnits: number | null;
  /** What that drift would be reported as, or null when it is below the floor. */
  driftSeverity: ObservationSeverity | null;
  /** True when the box has text in it that is not a weight. */
  invalid: boolean;
}

/**
 * The target-weights form.
 *
 * `saved` is what the server holds, read from the query cache; `edits` is what
 * has been typed since, and a box shows its edit or else the saved weight. They
 * are kept apart for the reasons `SettingsStore` keeps them apart — "unsaved
 * changes" becomes a fact the page can state, a failed save leaves the user's
 * typing on screen instead of silently reverting it, and a background re-read
 * never overwrites a box someone is typing in.
 *
 * The edits hold **text**, not numbers. Halfway through typing `25.5` the box
 * contains `25.`, which is not a number, and a store that insisted on numbers
 * would either fight the cursor or invent a zero. The text is parsed where it
 * is read, and the empty box is a state in its own right: it means *no target
 * for this instrument*, which is a different statement from a target of zero
 * and produces a different set of findings. See `targetWeights.ts`.
 */
export class TargetsStore {
  /** Symbol -> the text typed into that row's box. Empty string means no target. */
  edits = new Map<string, string>();

  saving = false;
  /** Why the last save failed. A failed *load* is the query's to report. */
  error: string | null = null;
  savedAt: Date | null = null;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  /** Symbol -> stored weight in integer units. Null before the first read. */
  get saved(): Map<string, number> | null {
    const stored = this.root.targetsCache.data;
    if (stored === undefined) return null;
    return new Map(stored.map((target) => [target.symbol, weightToUnits(target.weight)]));
  }

  /** Names for symbols that arrive from `/targets` rather than from a holding. */
  private get names(): Map<string, string | null> {
    return new Map((this.root.targetsCache.data ?? []).map((t) => [t.symbol, t.name]));
  }

  /** What one row's box shows: what was typed, or else the stored weight. */
  textFor(symbol: string): string {
    const typed = this.edits.get(symbol);
    if (typed !== undefined) return typed;
    const units = this.saved?.get(symbol);
    return units === undefined ? '' : unitsToPercent(units);
  }

  /**
   * One row per instrument this user could sensibly have an opinion about:
   * everything held, plus everything already targeted.
   *
   * A target on an instrument that was never held cannot be added here, because
   * the route only accepts symbols the portfolio already knows and there is no
   * instrument row until a holding or an import creates one. That is the same
   * rule the API states, not an extra restriction — but it is a real limit, and
   * the page says so rather than offering a box that would be refused.
   */
  get rows(): TargetRow[] {
    // Until the portfolio has loaded there is no weight to compare against, and
    // an absent portfolio must not read as an empty one: every target would
    // otherwise show as 0% held, which is a specific and wrong claim.
    const portfolio = this.root.portfolioCache.data ?? null;
    const holdings = portfolio?.holdings ?? [];
    const bySymbol = new Map(holdings.map((holding) => [holding.instrument.symbol, holding]));
    const symbols = new Set<string>([...bySymbol.keys(), ...(this.saved?.keys() ?? [])]);

    return [...symbols]
      .map((symbol): TargetRow => {
        const holding = bySymbol.get(symbol);
        const targetText = this.textFor(symbol);
        const targetUnits = percentToUnits(targetText);
        const actualUnits =
          portfolio === null
            ? null
            : holding === undefined
              ? // Not held at all: an exact weight of zero, which is what makes
                // "you hold none of the 10% you asked for" a real drift rather
                // than a missing measurement. The engine reads it the same way.
                0
              : holding.weightPct === null
                ? null
                : actualWeightUnits(holding.weightPct);
        const driftUnits =
          actualUnits === null || targetUnits === null ? null : actualUnits - targetUnits;
        return {
          symbol,
          name: holding?.instrument.name ?? this.names.get(symbol) ?? null,
          held: holding !== undefined,
          actualUnits,
          targetText,
          targetUnits,
          driftUnits,
          driftSeverity: driftUnits === null ? null : driftSeverity(driftUnits),
          invalid: targetText.trim() !== '' && targetUnits === null,
        };
      })
      .sort(byWeightThenSymbol);
  }

  /** What the boxes currently add up to, in integer units. */
  get totalUnits(): number {
    return this.rows.reduce((sum, row) => sum + (row.targetUnits ?? 0), 0);
  }

  /**
   * The share of the portfolio no target speaks for.
   *
   * Negative when the set oversubscribes the portfolio, which is the condition
   * the server refuses; the page shows the number rather than only the refusal.
   */
  get unallocatedUnits(): number {
    return WEIGHT_UNITS_PER_PORTFOLIO - this.totalUnits;
  }

  /**
   * The draft as the API would receive it: symbol -> units, blanks dropped.
   *
   * A blank box is an instruction to remove that target, so it is absent here
   * rather than present as a zero.
   */
  get pending(): Map<string, number> {
    const pending = new Map<string, number>();
    this.rows.forEach((row) => {
      if (row.targetUnits !== null) pending.set(row.symbol, row.targetUnits);
    });
    return pending;
  }

  get isDirty(): boolean {
    if (this.saved === null) return false;
    /**
     * A box holding text that is not a weight counts as a change, even though
     * it contributes no value to compare. It was found by using the page: an
     * unparseable box parses to nothing, so a draft containing one looked
     * identical to the stored set, `isDirty` was false, and **Discard was
     * disabled at exactly the moment it is wanted** - the user's way back from
     * a typo was the one control switched off. The form no longer says what the
     * server holds, so there is something to discard.
     */
    if (this.rows.some((row) => row.invalid)) return true;
    const pending = this.pending;
    if (pending.size !== this.saved.size) return true;
    for (const [symbol, units] of pending) {
      if (this.saved.get(symbol) !== units) return true;
    }
    return false;
  }

  /**
   * Why the draft cannot be sent, or null when it can.
   *
   * These mirror the route's own checks rather than replacing them — the server
   * is still the authority and still answers 422 — but a rule the user can only
   * discover by being refused is a worse way to learn it than one the form
   * states while there is still something to correct.
   */
  get blockingIssue(): string | null {
    const invalid = this.rows.filter((row) => row.invalid);
    if (invalid.length > 0) {
      return t('validation.targetFormat', {
        symbols: invalid.map((row) => row.symbol).join(t('common.listSeparator')),
      });
    }
    const over = this.rows.filter(
      (row) => row.targetUnits !== null && row.targetUnits > WEIGHT_UNITS_PER_PORTFOLIO,
    );
    if (over.length > 0) {
      return t('validation.targetOver100', {
        symbols: over.map((row) => row.symbol).join(t('common.listSeparator')),
      });
    }
    if (this.totalUnits > WEIGHT_UNITS_PER_PORTFOLIO) {
      // A set summing over 100% describes a portfolio larger than itself, so no
      // allocation could ever satisfy it and every drift against it would be
      // permanent. Summing to *less* is fine and deliberately not flagged.
      return t('validation.targetsTotal', { total: unitsToPercent(this.totalUnits) });
    }
    return null;
  }

  get canSave(): boolean {
    return this.isDirty && !this.saving && this.blockingIssue === null;
  }

  /**
   * Whether drift can be computed at all right now.
   *
   * The engine produces no allocation-drift finding whatsoever while any
   * holding is unpriced: the denominator would be smaller than the portfolio,
   * so every weight computed from it is overstated and the drift it reports
   * would be invented. Someone who has just set targets and is waiting to hear
   * about them deserves to know that is why they will not.
   */
  get driftBlockedBySymbols(): string[] {
    return this.root.portfolioCache.data?.summary.unpricedSymbols ?? [];
  }

  async save(): Promise<boolean> {
    if (this.saving || this.saved === null) return false;
    this.saving = true;
    this.error = null;
    try {
      const response = await api.put<TargetsUpdateResponse>('/targets', {
        // Sorted so two identical sets produce an identical request, which makes
        // a request log comparable across saves.
        targets: [...this.pending.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([symbol, units]) => ({ symbol, weight: unitsToWeight(units) })),
      });
      // From the response, so the form shows what was stored rather than what
      // was typed. The response carries no names, so a name already known is
      // kept rather than replaced by nothing.
      this.root.queryClient.setQueryData<TargetWeight[]>(queryKeys.targets, (previous) => {
        const known = new Map((previous ?? []).map((t) => [t.symbol, t.name]));
        return response.targets.map((target) => ({
          symbol: target.symbol,
          weight: target.weight,
          name: known.get(target.symbol) ?? null,
        }));
      });
      runInAction(() => {
        this.edits = new Map();
        this.savedAt = new Date();
      });
      return true;
    } catch (error) {
      runInAction(() => {
        this.error =
          error instanceof ApiRequestError ? error.message : t('errors.targetsSaveFailed');
      });
      return false;
    } finally {
      runInAction(() => {
        this.saving = false;
      });
    }
  }

  /** Type into one row. The text is kept exactly as written; parsing happens on read. */
  setTarget(symbol: string, text: string): void {
    this.edits.set(symbol, text);
  }

  /** Clear one row: no target, which is not the same as a target of zero. */
  clearTarget(symbol: string): void {
    this.edits.set(symbol, '');
  }

  /**
   * Fill every held row with an equal share of the portfolio.
   *
   * A convenience, and the one place the form proposes a number instead of
   * recording one. It is arithmetic on the holdings the user already chose, not
   * a recommendation about what to hold - guideline 2 - and the remainder from
   * an uneven division is left untargeted rather than pushed onto one row.
   */
  spreadEvenly(): void {
    const held = this.rows.filter((row) => row.held);
    if (held.length === 0) return;
    const each = Math.floor(WEIGHT_UNITS_PER_PORTFOLIO / held.length);
    held.forEach((row) => this.edits.set(row.symbol, unitsToPercent(each)));
  }

  /** Throw the edits away and go back to what the server holds. */
  discard(): void {
    this.edits = new Map();
    this.error = null;
  }

  reset(): void {
    this.edits = new Map();
    this.error = null;
    this.savedAt = null;
  }
}

/**
 * Biggest position first, so the rows that matter most to the allocation are at
 * the top, with everything unpriced or unheld after them in symbol order.
 */
function byWeightThenSymbol(left: TargetRow, right: TargetRow): number {
  const leftWeight = left.held ? (left.actualUnits ?? -1) : -1;
  const rightWeight = right.held ? (right.actualUnits ?? -1) : -1;
  if (leftWeight !== rightWeight) return rightWeight - leftWeight;
  return left.symbol.localeCompare(right.symbol);
}
