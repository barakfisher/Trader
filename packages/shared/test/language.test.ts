import { describe, expect, it } from 'vitest';

import { writtenLanguage } from '../src/language.js';

describe('writtenLanguage (D224)', () => {
  it.each(['מה המחיר של NVDA?', 'כמה שווה התיק', 'NVDA ירדה 3%?'])('reads %j as Hebrew', (text) =>
    expect(writtenLanguage(text)).toBe('he'),
  );

  it.each(['How is NVDA doing?', 'NVDA', '?', '', '3.5%'])('reads %j as English', (text) =>
    expect(writtenLanguage(text)).toBe('en'),
  );
});
