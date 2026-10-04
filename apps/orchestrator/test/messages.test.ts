/**
 * The orchestrator's own sentences, in every interface language.
 *
 * TypeScript already refuses a language missing a sentence. What it cannot
 * see is direction: a figure or a Latin fragment left bare in a Hebrew line is
 * reordered by the bidi algorithm (`-0.14` reads `0.14-`), so every one must
 * sit in an isolate - the same rule `test_hebrew_templates.py` holds the AI
 * service's Hebrew to.
 */

import { describe, expect, it } from 'vitest';

import { MESSAGES, observationTextIn, type Messages } from '../src/notify/messages.js';
import { appendOutcome } from '../src/telegram/updates.js';

/** Every sentence a language can produce, with representative arguments. */
function everySentence(messages: Messages): string[] {
  const fixed = [
    ...Object.values(messages.buttons),
    messages.undoButton,
    ...Object.values(messages.working),
    messages.openInApp,
    ...Object.values(messages.decisionReplies),
    ...Object.values(messages.refusalReplies),
    ...Object.values(messages.outcomeLines),
    messages.proposalGone,
    messages.cannotChange,
    messages.stillWorking,
    messages.buttonUnusable,
    messages.buttonInvalid,
    messages.nothingPending,
    messages.muteUsage,
    messages.disconnected,
    messages.commands,
    messages.connected,
    messages.chatTaken,
    messages.linkUsed,
    messages.linkInvalid,
    ...Object.values(messages.narration).flatMap((notice) => [notice.headline, notice.explanation]),
    messages.narrationFallback.headline,
    messages.narrationFallback.explanation,
    ...Object.values(messages.digest.reasons),
    messages.digest.topicsHeading,
  ].filter((text): text is string => text !== undefined);
  const { digest } = messages;
  return [
    ...fixed,
    messages.snoozedFor(4),
    messages.undoTooLate(60),
    messages.nowState('approved'),
    messages.mutedUntil('2026-10-03T08:00:00.000Z'),
    messages.alertingFrom(messages.severities.high!),
    digest.title(1, 1, true),
    digest.title(3, 2, false),
    digest.reasonLine(2, digest.reasons.quiet_hours),
    digest.noUnusualMove('uranium'),
    digest.notMeasured('nuclear', '1 of 4 instruments priced'),
    digest.notScanned('gasoline'),
    ...(['no_articles', 'not_scored', 'too_few_polarised', null] as const).flatMap((gap) => [
      digest.news(7, gap, 1, '-0.14', 'lexicon-v1'),
      digest.news(7, gap, 12, '+0.14', 'lexicon-v1'),
    ]),
  ];
}

const ISOLATED = /[⁦⁨][^⁦⁨⁩]*⁩/g;

describe('the Hebrew', () => {
  it.each(everySentence(MESSAGES.he))('leaves nothing left-to-right outside an isolate: %s', (text) => {
    expect(text.trim()).not.toBe('');
    expect(text.replace(ISOLATED, '')).not.toMatch(/[0-9A-Za-z%+]/);
  });

  it('says one of a thing in words, as the web catalogue does', () => {
    expect(MESSAGES.he.digest.title(1, 1, false)).toBe('סיכום יומי: ממצא אחד, נושא אחד');
  });
});

describe('every language', () => {
  it('produces the same number of sentences as English', () => {
    // A missing optional entry (a refusal, a reply) is the one gap the type
    // system allows; this is where it shows.
    for (const messages of Object.values(MESSAGES)) {
      expect(everySentence(messages)).toHaveLength(everySentence(MESSAGES.en).length);
    }
  });
});

describe('appendOutcome', () => {
  it('stacks an outcome under an earlier one in another language', () => {
    // The user can switch language between an approval and its undo; the
    // second line must still join the first block rather than open a new one.
    const once = appendOutcome('Alert', MESSAGES.en.outcomeLines.approved!);
    const twice = appendOutcome(once, MESSAGES.he.outcomeLines.pending!);
    expect(twice).toBe(`Alert\n\n${MESSAGES.en.outcomeLines.approved}\n${MESSAGES.he.outcomeLines.pending}`);
  });
});

describe('observationTextIn', () => {
  const observation = {
    headline: 'VOO is 12.3 percentage points below its 25.0% target',
    explanation: 'VOO is 12.7% of the portfolio against a target of 25.0%.',
    localized: { he: { headline: 'עברית', explanation: 'הסבר' } },
  };

  it('chooses the translation, and the English for English or a missing one', () => {
    expect(observationTextIn(observation, 'he').headline).toBe('עברית');
    expect(observationTextIn(observation, 'en').headline).toBe(observation.headline);
    expect(observationTextIn({ ...observation, localized: {} }, 'he').headline).toBe(observation.headline);
    expect(observationTextIn({ ...observation, localized: null }, 'he').headline).toBe(observation.headline);
  });
});
