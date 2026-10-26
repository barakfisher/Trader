/**
 * D258's fixture sender: records what would have been mailed, so no test sends
 * mail and a test can read the link a person would have clicked.
 */

import type { EmailMessage, EmailSender } from '../src/email/sender.js';

export class RecordingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  /** Set to make the next sends fail, as an SMTP server that refuses would. */
  failWith: Error | null = null;

  async send(message: EmailMessage): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
  }

  /** The token in the last link sent to `to`, read from its `#token=` fragment. */
  tokenSentTo(to: string): string | null {
    const message = [...this.sent].reverse().find((sent) => sent.to === to);
    const match = message?.text.match(/#token=([A-Za-z0-9_-]+)/);
    return match ? match[1]! : null;
  }

  /** Background sends resolve on a later tick; a test awaits them before reading `sent`. */
  async settled(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
