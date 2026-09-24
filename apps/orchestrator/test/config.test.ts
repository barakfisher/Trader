/**
 * Environment parsing, and specifically the difference between a setting that
 * is absent and one that is present but empty.
 *
 * This file exists because of a real outage in CI. `TELEGRAM_BOT_TOKEN` was
 * declared `z.string().min(1).optional()`, which is correct for an *absent*
 * variable and wrong for an empty one - and docker-compose passes through every
 * variable named in `.env.example`, so an unconfigured secret arrives as `''`.
 * `.optional()` did not fire, `.min(1)` refused the value, and the orchestrator
 * refused to boot over a setting documented as optional.
 *
 * Every unit test passed throughout, because they all build the environment as
 * an object and omit the keys they do not set - which is not how any deployment
 * supplies configuration. The lesson generalises past this one variable: an
 * optional setting has two spellings of "unset", and only one of them appears
 * in a test written by hand.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, resetConfigForTests } from '../src/config.js';

/** The minimum a deployment must supply for the service to boot at all. */
const REQUIRED = {
  APP_PASSPHRASE: 'test-passphrase',
  SESSION_SECRET: 'test-session-secret-value',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AI_SERVICE_URL: 'http://ai-service:8000',
  INTERNAL_API_KEY: 'internal-test-key',
};

const load = (extra: Record<string, string> = {}) =>
  loadConfig({ ...REQUIRED, ...extra } as unknown as NodeJS.ProcessEnv);

beforeEach(() => resetConfigForTests());

describe('TELEGRAM_UPDATES', () => {
  it('polls by default, since no installation has a webhook URL yet', () => {
    expect(load().TELEGRAM_UPDATES).toBe('polling');
  });

  it('boots with the variable present and empty, as compose passes it', () => {
    expect(load({ TELEGRAM_UPDATES: '' }).TELEGRAM_UPDATES).toBe('polling');
  });

  it('refuses a transport it does not know rather than guessing', () => {
    expect(() => load({ TELEGRAM_UPDATES: 'push' })).toThrow(/TELEGRAM_UPDATES/);
  });
});

describe('optional settings', () => {
  it('boots with the variable absent', () => {
    expect(load().TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it('boots with the variable present and empty', () => {
    // The case that took the service down: `.env.example` lists the key with no
    // value, compose passes it through as '', and an empty string is not the
    // same thing as an absent one to zod.
    expect(load({ TELEGRAM_BOT_TOKEN: '' }).TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it('keeps a value that was actually set', () => {
    expect(load({ TELEGRAM_BOT_TOKEN: 'a-real-token' }).TELEGRAM_BOT_TOKEN).toBe('a-real-token');
  });

  it('treats a whitespace-only value as a value, not as absence', () => {
    // Deliberate: a variable set to a space is a typo somebody made, and
    // quietly reading it as "unset" would hide it. Only the empty string, which
    // is what an unset compose variable actually produces, is absence.
    expect(load({ TELEGRAM_BOT_TOKEN: ' ' }).TELEGRAM_BOT_TOKEN).toBe(' ');
  });
});

describe('required settings', () => {
  it('refuses to boot when one is missing', () => {
    // The counterpart: optional settings degrade, required ones stop the
    // process at boot with a readable message rather than failing obscurely on
    // the first request.
    const { DATABASE_URL: _omitted, ...withoutDatabase } = REQUIRED;
    expect(() => loadConfig(withoutDatabase as unknown as NodeJS.ProcessEnv)).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('refuses to boot when a required setting is present but empty', () => {
    // Same two spellings of "unset", opposite correct answer: an empty
    // DATABASE_URL is not a deployment choice, it is a broken deployment.
    expect(() => load({ DATABASE_URL: '' })).toThrow(/Invalid environment configuration/);
  });
});
