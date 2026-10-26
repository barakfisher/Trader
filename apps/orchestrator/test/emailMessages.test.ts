/**
 * The mails the app sends (D258, D259, D303): every kind in every language,
 * as text and as HTML that lays out in the language's direction and cannot be
 * broken by what it quotes.
 */

import { describe, expect, it } from 'vitest';

import { UI_LANGUAGES } from '@traders/shared';

import { emailMessages } from '../src/email/messages.js';

const LINK = 'https://traders.example/verify#token=abc_DEF-123';

describe('the email catalogue', () => {
  const kinds = (language: (typeof UI_LANGUAGES)[number]) => [
    emailMessages.verifyEmail('a@example.com', language, LINK, 24),
    emailMessages.signupExists('a@example.com', language, 'https://traders.example/'),
    emailMessages.verifyNewEmail('a@example.com', language, LINK, 24),
    emailMessages.emailChangeRequested('a@example.com', language, 'new@example.com'),
    emailMessages.accountClosed('a@example.com', language, '2 November 2026 at 12:00', 'https://traders.example/'),
    emailMessages.accountRestored('a@example.com', language),
  ];

  it.each(UI_LANGUAGES)('writes every kind in %s, addressed, with a subject, text and HTML', (language) => {
    for (const message of kinds(language)) {
      expect(message.to).toBe('a@example.com');
      expect(message.subject.length).toBeGreaterThan(0);
      expect(message.text.length).toBeGreaterThan(0);
      expect(message.html).toContain(`lang="${language}"`);
      expect(message.html).toContain('name="viewport"');
    }
  });

  it('lays Hebrew out right to left, and keeps a link left to right inside it', () => {
    const [verify] = kinds('he');
    expect(verify!.html).toContain('dir="rtl"');
    expect(verify!.html).toContain(`<p dir="ltr" style="word-break:break-all"><a href="${LINK}">`);
    expect(verify!.text).toContain(`⁨${LINK}⁩`);
    expect(kinds('en')[0]!.text).toContain(`\n${LINK}\n`);
  });

  it('carries the link and its lifetime in the verification mails, and no link in the notices', () => {
    const [verify, exists, verifyNew, notice] = kinds('en');
    expect(verify!.text).toContain(LINK);
    expect(verify!.text).toContain('24 hours');
    expect(verifyNew!.text).toContain(LINK);
    expect(exists!.text).not.toContain('#token=');
    expect(notice!.text).not.toContain('#token=');
    expect(notice!.text).toContain('new@example.com');
  });

  it('says when a closed account goes and how to keep it, in each language (D264)', () => {
    for (const language of UI_LANGUAGES) {
      const closed = kinds(language)[4]!;
      expect(closed.text).toContain('2 November 2026 at 12:00');
      expect(closed.text).toContain('https://traders.example/');
      expect(closed.text).not.toContain('#token=');
    }
  });

  it('escapes what it quotes, so an address cannot write markup into the HTML', () => {
    const notice = emailMessages.emailChangeRequested('a@example.com', 'en', '"><script>x</script>@example.com');
    expect(notice.html).not.toContain('<script>');
    expect(notice.html).toContain('&quot;&gt;&lt;script&gt;');
  });
});
