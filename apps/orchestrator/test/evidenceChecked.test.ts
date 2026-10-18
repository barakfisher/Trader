import { describe, expect, it } from 'vitest';

import { evidenceCheckedFrom, MAX_SUBJECT_CHARS } from '../src/services/evidenceChecked.js';
import { messagesFor } from '../src/notify/messages.js';

/** A tool call as `llm/tool_loop.py` stores it: arguments are the model's JSON text. */
function call(name: string, args: Record<string, unknown> | string = {}) {
  return { id: `c-${name}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
}

describe('evidenceCheckedFrom', () => {
  it('lists each check once, in the order it was first made', () => {
    const checked = evidenceCheckedFrom([
      call('get_price_history', { symbol: 'NVDA', days: 21 }),
      call('get_news', { symbol: 'NVDA', days: 7 }),
      call('get_position'),
    ]);
    expect(checked).toEqual({
      checks: [
        { tool: 'get_price_history', subject: 'NVDA', days: 21 },
        { tool: 'get_news', subject: 'NVDA', days: 7 },
        { tool: 'get_position', subject: null, days: null },
      ],
      otherCalls: 0,
    });
  });

  it('merges repeated calls about one subject, keeping the widest window', () => {
    const checked = evidenceCheckedFrom([
      call('get_price_history', { symbol: 'nvda', days: 21 }),
      call('get_news', { symbol: 'NVDA' }),
      call('get_price_history', { symbol: ' NVDA ', days: 60 }),
      call('get_price_history', { symbol: 'NVDA', days: 5 }),
      call('get_news', { symbol: 'NVDA', days: 3 }),
      call('get_position'),
      call('get_position'),
    ]);
    expect(checked.checks).toEqual([
      { tool: 'get_price_history', subject: 'NVDA', days: 60 },
      { tool: 'get_news', subject: 'NVDA', days: 3 },
      { tool: 'get_position', subject: null, days: null },
    ]);
  });

  it('keeps calls about different subjects apart', () => {
    const checked = evidenceCheckedFrom([
      call('get_findings', { symbol: 'NVDA' }),
      call('get_findings', { symbol: 'AMD' }),
      call('get_quote', { symbols: ['amd', 'NVDA', 'AMD'] }),
    ]);
    expect(checked.checks).toEqual([
      { tool: 'get_findings', subject: 'NVDA', days: null },
      { tool: 'get_findings', subject: 'AMD', days: null },
      { tool: 'get_quote', subject: 'AMD, NVDA', days: null },
    ]);
  });

  it('answers no checks for a scan that called no tool', () => {
    expect(evidenceCheckedFrom([])).toEqual({ checks: [], otherCalls: 0 });
  });

  it('counts a tool it does not know, and never names it', () => {
    const checked = evidenceCheckedFrom([
      call('get_position'),
      call('delegate_research', { symbol: 'NVDA' }),
      call('delegate_research', { symbol: 'NVDA' }),
      { arguments: '{}' },
      null,
    ]);
    expect(checked.checks).toEqual([{ tool: 'get_position', subject: null, days: null }]);
    expect(checked.otherCalls).toBe(4);
    expect(JSON.stringify(checked)).not.toContain('delegate_research');
  });

  it('reads malformed or missing arguments as none, and still counts the check', () => {
    const checked = evidenceCheckedFrom([
      call('get_news', '{"symbol": "NV'),
      call('get_price_history', { symbol: 'NVDA', days: 'twenty' }),
      call('get_price_history', { symbol: 'TSLA', days: 2.5 }),
      { name: 'get_findings' },
    ]);
    expect(checked.checks).toEqual([
      { tool: 'get_news', subject: null, days: null },
      { tool: 'get_price_history', subject: 'NVDA', days: null },
      { tool: 'get_price_history', subject: 'TSLA', days: null },
      { tool: 'get_findings', subject: null, days: null },
    ]);
  });

  it('reads arguments stored as an object as well as JSON text', () => {
    const checked = evidenceCheckedFrom([{ name: 'get_news', arguments: { symbol: 'AAPL', days: 2 } }]);
    expect(checked.checks).toEqual([{ tool: 'get_news', subject: 'AAPL', days: 2 }]);
  });

  it('cuts a long search phrase, so the line stays a line', () => {
    const phrase = 'companies that make the machines which make semiconductor chips';
    const [check] = evidenceCheckedFrom([call('search_universe', { query: phrase })]).checks;
    expect(check!.subject!.length).toBeLessThanOrEqual(MAX_SUBJECT_CHARS);
    expect(check!.subject!.endsWith('…')).toBe(true);
    expect(phrase.startsWith(check!.subject!.slice(0, -1))).toBe(true);
  });
});

describe('the Telegram line', () => {
  const checked = evidenceCheckedFrom([
    call('get_price_history', { symbol: 'NVDA', days: 21 }),
    call('get_news', { symbol: 'NVDA', days: 7 }),
    call('get_position'),
    call('explain_concept', { query: 'drawdown' }),
    call('delegate_research'),
  ]);

  it('says each check through the catalogue, in English', () => {
    expect(messagesFor('en').evidenceChecked(checked)).toBe(
      'Checked: price history NVDA (21 trading days) · news NVDA (7 days) · position · glossary “drawdown” · 1 other tool',
    );
  });

  it('says it in Hebrew, with every Latin fragment isolated', () => {
    const line = messagesFor('he').evidenceChecked(checked);
    expect(line).toBe(
      'נבדק: היסטוריית מחירים ⁦NVDA⁩ (⁦' + '21⁩ ימי מסחר) · חדשות ⁦NVDA⁩ (⁦7⁩ ימים) · ' +
        'פוזיציה · מילון מונחים "⁨drawdown⁩" · כלי נוסף אחד',
    );
    for (const raw of ['get_', 'price_history', 'explain_concept', 'delegate_research']) expect(line).not.toContain(raw);
  });

  it('says plainly when the scan checked nothing', () => {
    const none = evidenceCheckedFrom([]);
    expect(messagesFor('en').evidenceChecked(none)).toBe('Checked: nothing - the agent decided from its briefing alone.');
    expect(messagesFor('he').evidenceChecked(none)).toBe('נבדק: כלום - הסוכן החליט על סמך התדריך בלבד.');
  });
});
