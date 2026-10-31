// @vitest-environment jsdom
/**
 * The header's version (D351, D352): the format scripts/app-version.sh prints
 * is the one the bundle parses, and the header shows when the commit landed on
 * the user's clock - or says it does not know - rather than inventing it.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { VersionLabel } from '../src/components/AppBar.tsx';
import { parseAppVersion, versionStamp } from '../src/lib/appVersion.ts';
import { t } from '../src/i18n/index.ts';

afterEach(cleanup);

// 16:12 UTC is 18:12 in Jerusalem (UTC+2 on this date), and 23:30 UTC is the next day there.
const LANDED = '2026-10-31T16:12:41Z';
const JERUSALEM = 'Asia/Jerusalem';

it('reads a clean and a dirty version', () => {
  expect(parseAppVersion(`${LANDED}+c2a9e55`)).toEqual({ committedAt: LANDED, commit: 'c2a9e55', dirty: false });
  expect(parseAppVersion(`${LANDED}+c2a9e55-dirty`)).toEqual({ committedAt: LANDED, commit: 'c2a9e55', dirty: true });
});

it.each([
  undefined,
  '',
  '0.1.0',
  '26.10.31+0cad4d6', // D351's format, before the time
  `${LANDED}`,
  `${LANDED}+XYZ`,
  `${LANDED}+c2a9e55-modified`,
  '2026-13-45T99:99:99Z+c2a9e55',
])('knows no version in %j', (raw) => {
  expect(parseAppVersion(raw)).toBeNull();
});

it("parses what this checkout's script prints", () => {
  const script = resolve(import.meta.dirname, '../../../scripts/app-version.sh');
  const printed = execFileSync('bash', [script], { encoding: 'utf8' }).trim();
  expect(parseAppVersion(printed)).not.toBeNull();
});

it("stamps the time on the user's clock, the date with it", () => {
  expect(versionStamp(LANDED, JERUSALEM)).toEqual({ date: '26.10.31', time: '18:12' });
  expect(versionStamp(LANDED, 'UTC')).toEqual({ date: '26.10.31', time: '16:12' });
  expect(versionStamp('2026-10-31T23:30:00Z', JERUSALEM)).toEqual({ date: '26.11.01', time: '01:30' });
});

it('shows the date and the time, and says them with the commit in words', () => {
  const { container } = render(
    <VersionLabel version={{ committedAt: LANDED, commit: 'c2a9e55', dirty: false }} timeZone={JERUSALEM} />,
  );
  const sentence = t('nav.version', { date: '26.10.31', time: '18:12', commit: 'c2a9e55' });
  // Left to right in every language, so a Hebrew page keeps the date before the time.
  expect(container.querySelector('[dir="ltr"]')?.textContent).toBe('26.10.31 18:12');
  expect(screen.getByText(sentence)).toBeTruthy();
  expect(screen.getByTitle(sentence)).toBeTruthy();
});

it('marks uncommitted changes', () => {
  const { container } = render(
    <VersionLabel version={{ committedAt: LANDED, commit: 'c2a9e55', dirty: true }} timeZone={JERUSALEM} />,
  );
  expect(container.querySelector('[dir="ltr"]')?.textContent).toBe('26.10.31 18:12*');
  expect(
    screen.getByText(t('nav.versionDirty', { date: '26.10.31', time: '18:12', commit: 'c2a9e55' })),
  ).toBeTruthy();
});

it('says the version is unknown when none was built in', () => {
  render(<VersionLabel version={null} timeZone={JERUSALEM} />);
  expect(screen.getByText(t('nav.versionUnknown'))).toBeTruthy();
});
