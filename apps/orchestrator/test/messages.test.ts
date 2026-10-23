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
    messages.unmuted,
    ...Object.values(messages.menu.commands),
    messages.menu.help,
    ...Object.values(messages.menu.buttons).filter((b): b is string => typeof b === 'string'),
    messages.menu.unavailable,
    ...Object.values(messages.menu.portfolio).filter((t): t is string => typeof t === 'string'),
    ...Object.values(messages.menu.status).filter((t): t is string => typeof t === 'string'),
    messages.menu.pending.title,
    ...Object.values(messages.menu.pending.states),
    ...Object.values(messages.menu.agents).filter((t): t is string => typeof t === 'string'),
    ...Object.values(messages.menu.agent).filter((t): t is string => typeof t === 'string'),
    ...Object.values(messages.menu.agent.states),
    ...Object.values(messages.menu.log).filter((t): t is string => typeof t === 'string'),
    ...Object.values(messages.menu.log.triggers),
    ...Object.values(messages.menu.log.outcomes),
    messages.connected,
    messages.chatTaken,
    messages.linkUsed,
    messages.linkInvalid,
    messages.privateChatOnly,
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
    messages.menu.buttons.mute(1),
    messages.menu.buttons.mute(4),
    messages.menu.asOf('14:05'),
    messages.menu.portfolio.value('$12,345.67'),
    messages.menu.portfolio.today('+$12.00', '+0.10%'),
    messages.menu.portfolio.holdings(1, 1),
    messages.menu.portfolio.holdings(12, 11),
    messages.menu.portfolio.unpriced(['ACME', 'XYZ']),
    messages.menu.status.alertingFrom(messages.severities.high!),
    messages.menu.status.mutedUntil('Thu 23 Oct 08:00'),
    messages.menu.status.quietHours('22:00', '07:00'),
    messages.menu.status.mutedToast(1),
    messages.menu.status.mutedToast(4),
    messages.menu.agents.scansADay(0),
    messages.menu.agents.scansADay(1),
    messages.menu.agents.scansADay(3),
    messages.menu.agent.running('14:05'),
    messages.menu.agent.schedule([messages.scheduledScans.slot('pre_open'), messages.scheduledScans.slot('ny_1000')]),
    messages.menu.agent.nextScan('Thu 23 Oct 16:00'),
    messages.menu.agent.cash('$1,000.00', '$10,000.00'),
    messages.menu.agent.netWorth('$10,500.00', '+$500.00', '+5.00%'),
    messages.menu.agent.unpriced(['ACME']),
    messages.menu.agent.holdings(1),
    messages.menu.agent.holdings(3),
    messages.menu.agent.spentToday('$0.07', '$0.50'),
    messages.menu.buttons.confirmRun('$0.04'),
    messages.menu.buttons.everyHours(1),
    messages.menu.buttons.everyHours(4),
    messages.menu.buttons.preOpen(true),
    messages.menu.buttons.postClose(false),
    messages.menu.run.confirm('Tech Agent', '$0.04', '$0.07', '$0.50'),
    messages.menu.run.running('Tech Agent'),
    ...Object.values(messages.menu.run.refusals),
    messages.menu.run.failed(messages.menu.run.refusals.scan_running),
    messages.menu.run.startedToast,
    ...Object.values(messages.menu.control).filter((t): t is string => typeof t === 'string'),
    messages.menu.control.limitReached(3),
    messages.menu.schedule.title('Tech Agent'),
    messages.menu.proposal.openUntil('Thu 23 Oct 16:00'),
    messages.menu.proposal.snoozedUntil('14:05'),
    messages.menu.proposal.notOpen,
    messages.menu.proposal.chooseOne,
    messages.menu.schedule.hint(messages.scheduledScans.slot('ny_1000')),
    messages.menu.log.title('Tech Agent'),
    messages.menu.log.started('Thu 23 Oct 14:05', messages.menu.log.triggers.schedule),
    messages.menu.log.outcome(messages.menu.log.outcomes.trade),
    messages.menu.log.trade('buy', '3', 'AAPL') + messages.menu.log.proposalNow(messages.menu.pending.states.pending!),
    messages.menu.log.trade('sell', '0.5', 'VOO') + messages.menu.log.refused('cash buffer'),
    messages.menu.log.cost('$0.04', 'google/gemini-2.5-flash'),
    messages.menu.log.cost('$0.04', null),
    digest.title(1, 1, true, 0),
    digest.title(3, 2, false, 1),
    ...[
      messages.modelFallback.where.assistant,
      messages.modelFallback.where.explain,
      messages.modelFallback.where.agent('Tech Agent'),
    ].flatMap((where) => {
      const notice = messages.modelFallback.notice(where, 'acme/retired-1', 'google/gemini-3.5-flash-lite');
      return [notice.headline, notice.explanation];
    }),
    messages.modelFallback.answerMark('acme/retired-1'),
    messages.modelFallback.digestLine(1),
    messages.modelFallback.digestLine(2),
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

const ISOLATED = /[\u2066\u2068][^\u2066\u2068\u2069]*\u2069/g;

describe('the Hebrew', () => {
  it.each(everySentence(MESSAGES.he))('leaves nothing left-to-right outside an isolate: %s', (text) => {
    expect(text.trim()).not.toBe('');
    expect(text.replace(ISOLATED, '')).not.toMatch(/[0-9A-Za-z%+]/);
  });

  it('says one of a thing in words, as the web catalogue does', () => {
    expect(MESSAGES.he.digest.title(1, 1, false, 0)).toBe('סיכום יומי: ממצא אחד, נושא אחד');
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
