/**
 * An agent's mandate in the form: the draft the fields edit, the presets that
 * fill it, and the instructions text written from it (D165-D174).
 *
 * - **The risk slider proposes rule values** (D169). Moving it fills max
 *   position, cash buffer and max holdings from `RISK_PRESETS`, except a rule
 *   the user typed by hand: once edited, a rule is theirs and the slider leaves
 *   it alone.
 * - **The templates are full presets** (D168): a template click fills the
 *   mandate as well as the name and persona.
 * - **The instructions are written from the settings** (D174), in code, in the
 *   user's language, and in words, never figures: a limit changed later must
 *   not leave a stale number in the text. The text is refilled on every change
 *   only while it is empty or still exactly what was last written for the user;
 *   once they edit it, it is theirs (`withMandate`).
 */

import {
  type AgentMandate,
  type Horizon,
  type MarketCap,
  type ThesisStyle,
  type UniverseTaxonomyResponse,
} from '@traders/shared';

import { currentLanguage, t } from '../i18n/index.ts';
import type { PersonaTemplate } from './personaTemplates.ts';

/** The rules the slider proposes and a hand edit takes over. */
export type SizedRule = 'maxPositionPct' | 'cashBufferPct' | 'maxHoldings';

export interface MandateDraft {
  riskLevel: number | null;
  horizon: Horizon | null;
  thesisStyle: ThesisStyle | null;
  /** Percent of capital as typed ("12.5"); '' is no limit. */
  maxPositionPct: string;
  cashBufferPct: string;
  maxHoldings: string;
  allowEtfs: boolean;
  marketCaps: MarketCap[];
  sectors: string[];
  industries: string[];
  etfCategories: string[];
  /** Tickers as typed, separated by commas or spaces. */
  blockedSymbols: string;
  /** Rules the user typed by hand: the slider no longer moves them (D169). */
  edited: SizedRule[];
}

export const EMPTY_MANDATE_DRAFT: MandateDraft = {
  riskLevel: null,
  horizon: null,
  thesisStyle: null,
  maxPositionPct: '',
  cashBufferPct: '',
  maxHoldings: '',
  allowEtfs: true,
  marketCaps: [],
  sectors: [],
  industries: [],
  etfCategories: [],
  blockedSymbols: '',
  edited: [],
};

/**
 * What each risk level proposes (D169): a bolder level allows a larger single
 * position, keeps less cash back and holds fewer names. Percent of capital.
 */
export const RISK_PRESETS: Record<number, { maxPositionPct: string; cashBufferPct: string; maxHoldings: string }> = {
  1: { maxPositionPct: '5', cashBufferPct: '40', maxHoldings: '25' },
  2: { maxPositionPct: '5', cashBufferPct: '30', maxHoldings: '20' },
  3: { maxPositionPct: '8', cashBufferPct: '25', maxHoldings: '18' },
  4: { maxPositionPct: '10', cashBufferPct: '20', maxHoldings: '15' },
  5: { maxPositionPct: '12', cashBufferPct: '15', maxHoldings: '12' },
  6: { maxPositionPct: '15', cashBufferPct: '10', maxHoldings: '10' },
  7: { maxPositionPct: '18', cashBufferPct: '8', maxHoldings: '9' },
  8: { maxPositionPct: '20', cashBufferPct: '5', maxHoldings: '8' },
  9: { maxPositionPct: '25', cashBufferPct: '5', maxHoldings: '6' },
  10: { maxPositionPct: '30', cashBufferPct: '2', maxHoldings: '5' },
};

/** The five words the prompt reads (D169), two levels each - as `mandate.py` has them. */
export const RISK_BANDS = ['ultraConservative', 'conservative', 'balanced', 'growth', 'aggressive'] as const;
export type RiskBand = (typeof RISK_BANDS)[number];

export function riskBand(level: number | null): RiskBand | null {
  return level === null ? null : RISK_BANDS[Math.floor((level - 1) / 2)]!;
}

/** Each template's mandate (D168), in the spirit of its persona text. */
const TEMPLATE_MANDATES: Record<PersonaTemplate, Partial<MandateDraft> & { riskLevel: number }> = {
  warren: { riskLevel: 3, horizon: 'long', thesisStyle: 'academic', marketCaps: ['mega', 'large'] },
  george: { riskLevel: 7, horizon: 'medium', thesisStyle: 'contrarian' },
  ray: { riskLevel: 2, horizon: 'long', thesisStyle: 'academic' },
  cathie: {
    riskLevel: 9,
    horizon: 'long',
    thesisStyle: 'growth',
    sectors: ['Technology', 'Healthcare'],
    etfCategories: ['Digital Assets', 'Equity Digital Assets'],
  },
};

/**
 * A template's mandate, every rule from its risk level. Classifications the
 * universe does not hold are left out rather than refused at save: the
 * template is a starting point, and this installation's universe decides.
 */
export function templateMandate(template: PersonaTemplate, taxonomy: UniverseTaxonomyResponse | undefined): MandateDraft {
  const preset = TEMPLATE_MANDATES[template];
  const known = knownNames(taxonomy);
  return {
    ...EMPTY_MANDATE_DRAFT,
    ...RISK_PRESETS[preset.riskLevel],
    ...preset,
    sectors: (preset.sectors ?? []).filter((name) => known.sectors.has(name)),
    etfCategories: (preset.etfCategories ?? []).filter((name) => known.etfCategories.has(name)),
    edited: [],
  };
}

function knownNames(taxonomy: UniverseTaxonomyResponse | undefined) {
  return {
    sectors: new Set((taxonomy?.sectors ?? []).map((sector) => sector.name)),
    etfCategories: new Set([
      ...(taxonomy?.etfCategories ?? []).map((entry) => entry.name),
      ...(taxonomy?.sectors ?? []).flatMap((sector) => sector.etfCategories.map((entry) => entry.name)),
    ]),
  };
}

/** The slider moved: its proposals fill every rule the user has not typed (D169). */
export function applyRisk(draft: MandateDraft, level: number | null): MandateDraft {
  if (level === null) return { ...draft, riskLevel: null };
  const preset = RISK_PRESETS[level]!;
  const next = { ...draft, riskLevel: level };
  for (const rule of ['maxPositionPct', 'cashBufferPct', 'maxHoldings'] as const) {
    if (!draft.edited.includes(rule)) next[rule] = preset[rule];
  }
  return next;
}

/** A rule typed by hand: stored as typed, and the slider stops moving it. */
export function editRule(draft: MandateDraft, rule: SizedRule, value: string): MandateDraft {
  return { ...draft, [rule]: value, edited: draft.edited.includes(rule) ? draft.edited : [...draft.edited, rule] };
}

const PERCENT = /^(\d{1,3})(?:\.(\d{1,2}))?$/;

/** "12.5" -> 1250 basis points, in integers; null for '' and undefined for nonsense. */
export function percentToBps(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const match = PERCENT.exec(trimmed);
  if (!match) return undefined;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export function bpsToPercent(bps: number | null): string {
  if (bps === null) return '';
  const whole = Math.floor(bps / 100);
  const cents = bps % 100;
  return cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, '0').replace(/0$/, '')}`;
}

export function parseSymbols(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
}

const SYMBOL = /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/;

/** Which fields cannot be sent as typed; empty when the draft is valid. */
export function mandateProblems(draft: MandateDraft): (SizedRule | 'blockedSymbols')[] {
  const problems: (SizedRule | 'blockedSymbols')[] = [];
  const position = percentToBps(draft.maxPositionPct);
  if (position === undefined || (position !== null && (position < 1 || position > 10_000))) {
    problems.push('maxPositionPct');
  }
  const buffer = percentToBps(draft.cashBufferPct);
  if (buffer === undefined || (buffer !== null && buffer > 9_999)) problems.push('cashBufferPct');
  const holdings = draft.maxHoldings.trim();
  if (holdings !== '' && !(/^\d{1,3}$/.test(holdings) && Number(holdings) >= 1 && Number(holdings) <= 100)) {
    problems.push('maxHoldings');
  }
  if (parseSymbols(draft.blockedSymbols).some((symbol) => !SYMBOL.test(symbol))) problems.push('blockedSymbols');
  return problems;
}

/** The draft as the API takes it: every field, so a save states the whole mandate. */
export function mandateInput(draft: MandateDraft): AgentMandate {
  const holdings = draft.maxHoldings.trim();
  return {
    riskLevel: draft.riskLevel,
    horizon: draft.horizon,
    thesisStyle: draft.thesisStyle,
    maxPositionBps: percentToBps(draft.maxPositionPct) ?? null,
    cashBufferBps: percentToBps(draft.cashBufferPct) ?? null,
    maxHoldings: holdings === '' ? null : Number(holdings),
    allowEtfs: draft.allowEtfs,
    marketCaps: draft.marketCaps,
    sectors: draft.sectors,
    industries: draft.industries,
    etfCategories: draft.etfCategories,
    blockedSymbols: parseSymbols(draft.blockedSymbols),
  };
}

/** A stored mandate as a draft. Every stored rule counts as typed: the slider proposes, never overrides. */
export function draftFromMandate(mandate: AgentMandate | null): MandateDraft {
  if (!mandate) return EMPTY_MANDATE_DRAFT;
  const draft: MandateDraft = {
    riskLevel: mandate.riskLevel,
    horizon: mandate.horizon,
    thesisStyle: mandate.thesisStyle,
    maxPositionPct: bpsToPercent(mandate.maxPositionBps),
    cashBufferPct: bpsToPercent(mandate.cashBufferBps),
    maxHoldings: mandate.maxHoldings === null ? '' : String(mandate.maxHoldings),
    allowEtfs: mandate.allowEtfs,
    marketCaps: mandate.marketCaps,
    sectors: mandate.sectors,
    industries: mandate.industries,
    etfCategories: mandate.etfCategories,
    blockedSymbols: mandate.blockedSymbols.join(', '),
    edited: [],
  };
  draft.edited = (['maxPositionPct', 'cashBufferPct', 'maxHoldings'] as const).filter((rule) => draft[rule] !== '');
  return draft;
}

function list(items: string[]): string {
  return new Intl.ListFormat(currentLanguage(), { style: 'long', type: 'conjunction' }).format(items);
}

/**
 * The instructions written from the settings (D174): words, never figures, in
 * the user's language. '' when nothing is set that words could describe.
 */
export function describeMandate(draft: MandateDraft): string {
  const sentences: string[] = [];
  const band = riskBand(draft.riskLevel);
  if (band) sentences.push(t(`agents.mandate.describe.risk.${band}`));
  if (draft.horizon) sentences.push(t(`agents.mandate.describe.horizon.${draft.horizon}`));
  if (draft.thesisStyle) sentences.push(t(`agents.mandate.describe.style.${draft.thesisStyle}`));
  const focus = [...draft.sectors, ...draft.industries, ...draft.etfCategories];
  if (focus.length > 0) sentences.push(t('agents.mandate.describe.focus', { focus: list(focus) }));
  if (draft.marketCaps.length > 0) {
    sentences.push(
      t('agents.mandate.describe.caps', {
        caps: list(draft.marketCaps.map((cap) => t(`agents.mandate.describe.capWords.${cap}`))),
      }),
    );
  }
  if (!draft.allowEtfs) sentences.push(t('agents.mandate.describe.noEtfs'));
  return sentences.join(' ');
}

export interface InstructionsState {
  persona: string;
  /** The text last written from the settings: while the persona equals it, it is still ours to rewrite. */
  generated: string;
}

/** The settings changed: rewrite the instructions only if the user has not made them theirs. */
export function withMandate<T extends InstructionsState & { mandate: MandateDraft }>(draft: T, mandate: MandateDraft): T {
  const generated = describeMandate(mandate);
  const untouched = draft.persona.trim() === '' || draft.persona === draft.generated;
  return { ...draft, mandate, generated, persona: untouched ? generated : draft.persona };
}

export type OverLimit = { kind: 'position'; symbol: string } | { kind: 'cash' } | { kind: 'holdings' };

/**
 * Where the agent stands outside its own limits now - after a limit was
 * tightened, or a trade placed by hand. Reported, never acted on: limits apply
 * to future buys and nothing is sold (D168). Capital is cash plus holdings at
 * cost (D171), compared in integers; a holding with no known cost is not judged.
 */
export function overLimits(
  mandate: AgentMandate | null,
  account: { cashMinor: number; holdings: { instrument: { symbol: string }; costMinor: number | null }[] },
): OverLimit[] {
  if (!mandate) return [];
  const capital = account.holdings.reduce((sum, holding) => sum + (holding.costMinor ?? 0), account.cashMinor);
  const over: OverLimit[] = [];
  if (mandate.maxPositionBps !== null) {
    for (const holding of account.holdings) {
      if (holding.costMinor !== null && holding.costMinor * 10_000 > mandate.maxPositionBps * capital) {
        over.push({ kind: 'position', symbol: holding.instrument.symbol });
      }
    }
  }
  if (mandate.cashBufferBps !== null && account.cashMinor * 10_000 < mandate.cashBufferBps * capital) {
    over.push({ kind: 'cash' });
  }
  if (mandate.maxHoldings !== null && account.holdings.length > mandate.maxHoldings) over.push({ kind: 'holdings' });
  return over;
}
