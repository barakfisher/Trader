import { describe, expect, it } from 'vitest';

import { EMAIL_MAX_LENGTH, emailProblem, normaliseEmail } from '../src/email.js';

describe('the email rule', () => {
  it('accepts plain addresses, with plus tags, dots and subdomains', () => {
    for (const email of ['dana@example.com', 'dana.levi+traders@mail.example.co.il', 'admin@traders.localhost', "o'brien@example.org"]) {
      expect(emailProblem(normaliseEmail(email)), email).toBeNull();
    }
  });

  // A mail library reads `to` as an address list: each of these names an
  // address other than the one that was checked, or none at all.
  it('refuses anything a mail library could read as a list, a display name or a group', () => {
    for (const email of [
      'victim@example.com,attacker',
      'victim@example.com;attacker@evil.test',
      'name<attacker@evil.test>',
      '"a,b"@example.com',
      'group:attacker@evil.test;',
      'a@b@example.com',
      'dana @example.com',
    ]) {
      expect(emailProblem(email), email).toBe('invalid');
    }
  });

  it('refuses a missing domain dot, stray dots and bad labels', () => {
    for (const email of ['dana@localhost', '.dana@example.com', 'dana.@example.com', 'da..na@example.com', 'dana@-example.com', 'dana@example..com', 'dana@example.com.']) {
      expect(emailProblem(email), email).toBe('invalid');
    }
  });

  it('refuses an address past the maximum length', () => {
    const local = 'a'.repeat(EMAIL_MAX_LENGTH);
    expect(emailProblem(`${local}@example.com`)).toBe('too_long');
  });
});
