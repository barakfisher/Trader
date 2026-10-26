/** What a mail failure leaves in the log (D310): the SMTP code and command, never the address. */

import { describe, expect, it } from 'vitest';

const { mailFailure } = await import('../src/http/accountMail.js');

describe('a mail failure in the log', () => {
  it('keeps the SMTP code, reply code and command, and drops everything naming the recipient', () => {
    const error = Object.assign(new Error('Message failed: 550 <noa@example.com> mailbox unavailable'), {
      code: 'EENVELOPE',
      responseCode: 550,
      command: 'RCPT TO',
      rejected: ['noa@example.com'],
      response: '550 <noa@example.com> mailbox unavailable',
    });
    const logged = mailFailure(error);
    expect(logged).toEqual({ code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' });
    expect(JSON.stringify(logged)).not.toContain('noa@example.com');
  });

  it('logs nothing for something that is not an error object', () => {
    expect(mailFailure('noa@example.com')).toEqual({});
  });
});
