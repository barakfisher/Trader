/**
 * When two themes are the same: the rule rejection memory stands on (FR-11).
 *
 * The cases are the ones the rule was chosen for. "Uranium miners" after
 * "uranium" is the words half; "nuclear fuel" after "uranium" is the
 * instruments half; and a broader label, or a mostly-new basket, is not a match.
 */

import { describe, expect, it } from 'vitest';

import {
  INSTRUMENT_OVERLAP,
  firstMatch,
  instrumentOverlap,
  matchReason,
  matchWords,
  wordsCovered,
  type KnownTheme,
} from '../src/services/topicMatching.js';

const URANIUM_SET = ['ccj', 'ura', 'nxe', 'uec', 'dnn'];

describe('matchWords', () => {
  it('ignores case, plurals, filler and order', () => {
    expect(matchWords('Uranium Miners')).toEqual(['miner', 'uranium']);
    expect(matchWords('the uranium miner stocks')).toEqual(['miner', 'uranium']);
  });

  it('keeps a double-s word whole', () => {
    expect(matchWords('Glass')).toEqual(['glass']);
  });

  it('returns nothing for a label of filler words', () => {
    expect(matchWords('The stocks')).toEqual([]);
  });
});

describe('the words half', () => {
  it('suppresses a narrower label of a rejected theme', () => {
    expect(wordsCovered(matchWords('Uranium miners'), matchWords('uranium'))).toBe(true);
  });

  it('does not suppress a broader label', () => {
    expect(wordsCovered(matchWords('energy'), matchWords('nuclear energy'))).toBe(false);
  });

  it('never matches against a wordless label', () => {
    expect(wordsCovered(matchWords('anything'), [])).toBe(false);
  });
});

describe('the instruments half', () => {
  it('is measured over the new proposal, not the known set', () => {
    // 2 of the candidate's 2 are known (100%), though only 2 of the known 5.
    expect(instrumentOverlap(['ccj', 'ura'], URANIUM_SET)).toBe(1);
    expect(instrumentOverlap(['ccj', 'x', 'y', 'z'], URANIUM_SET)).toBe(0.25);
  });

  it('is zero for an empty candidate', () => {
    expect(instrumentOverlap([], URANIUM_SET)).toBe(0);
  });

  it('suppresses a re-wording naming mostly the same instruments', () => {
    const nuclearFuel = { words: matchWords('nuclear fuel'), instrumentIds: ['ccj', 'ura', 'nxe', 'uec', 'leu'] };
    const uranium = { words: matchWords('uranium'), instrumentIds: URANIUM_SET };
    expect(matchReason(nuclearFuel, uranium)).toBe('instruments');
  });

  it('matches exactly at the threshold and not below it', () => {
    const known = { words: ['x'], instrumentIds: ['a', 'b'] };
    const atThreshold = ['a', 'c'];
    expect(instrumentOverlap(atThreshold, known.instrumentIds)).toBe(INSTRUMENT_OVERLAP);
    expect(matchReason({ words: ['y'], instrumentIds: atThreshold }, known)).toBe('instruments');
    expect(matchReason({ words: ['y'], instrumentIds: ['a', 'c', 'd'] }, known)).toBeNull();
  });
});

describe('firstMatch', () => {
  const themes: KnownTheme[] = [
    { topicId: 't1', label: 'uranium', status: 'rejected', words: ['uranium'], instrumentIds: URANIUM_SET },
    { topicId: 't2', label: 'AI chips', status: 'active', words: ['ai', 'chip'], instrumentIds: ['nvda'] },
  ];

  it('reports the theme and the reason', () => {
    const match = firstMatch({ words: matchWords('Uranium miners'), instrumentIds: [] }, themes);
    expect(match?.theme.topicId).toBe('t1');
    expect(match?.reason).toBe('words');
  });

  it('returns null for a new theme', () => {
    expect(firstMatch({ words: matchWords('lithium'), instrumentIds: ['alb', 'sqm'] }, themes)).toBeNull();
  });
});
