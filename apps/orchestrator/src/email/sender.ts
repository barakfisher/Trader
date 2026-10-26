/**
 * Outbound mail (D258): everything that sends goes through `EmailSender`, so
 * the provider is configuration and a test records instead of sending.
 *
 * The one implementation is SMTP through `nodemailer`. Compose and kind point
 * it at Mailpit, which catches every message on this machine (D307); the public
 * host points it at the provider chosen at deployment, from a domain with SPF
 * and DKIM records.
 */

import nodemailer, { type Mail } from 'nodemailer';

import type { Config } from '../config.js';

export interface EmailMessage {
  to: string;
  subject: string;
  /** The message as plain text: what every client can show. */
  text: string;
  /** The same as HTML, so a right-to-left language is laid out right to left. */
  html: string;
}

export interface EmailSender {
  /** Resolves once the server accepted the message; throws if it did not. */
  send(message: EmailMessage): Promise<void>;
}

/** How long one message may take to hand over before it counts as failed. */
export const SMTP_TIMEOUT_MS = 15_000;

export class SmtpEmailSender implements EmailSender {
  private readonly transport: Mail;

  constructor(
    private readonly from: string,
    options: { host: string; port: number; secure: boolean; user?: string; password?: string },
  ) {
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      ...(options.user && options.password ? { auth: { user: options.user, pass: options.password } } : {}),
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

/** The configured sender, or null where no mail can be sent (`SMTP_HOST` or `EMAIL_FROM` unset). */
export function buildEmailSender(config: Config): EmailSender | null {
  if (!config.emailConfigured) return null;
  return new SmtpEmailSender(config.EMAIL_FROM!, {
    host: config.SMTP_HOST!,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    user: config.SMTP_USER,
    password: config.SMTP_PASSWORD,
  });
}
