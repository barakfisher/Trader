// @vitest-environment jsdom
/**
 * The header's version (D351): the format scripts/app-version.sh prints is the
 * one the bundle parses, and the header shows the commit - or says it does not
 * know one - rather than inventing it.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { VersionLabel } from '../src/components/AppBar.tsx';
import { parseAppVersion } from '../src/lib/appVersion.ts';
import { t } from '../src/i18n/index.ts';

afterEach(cleanup);

it('reads a clean and a dirty version', () => {
  expect(parseAppVersion('26.10.31+0cad4d6')).toEqual({ date: '26.10.31', commit: '0cad4d6', dirty: false });
  expect(parseAppVersion('26.10.31+0cad4d6-dirty')).toEqual({ date: '26.10.31', commit: '0cad4d6', dirty: true });
});

it.each([undefined, '', '0.1.0', '26.10.31', '26.10.31+XYZ', '26.10.31+0cad4d6-modified'])(
  'knows no version in %j',
  (raw) => {
    expect(parseAppVersion(raw)).toBeNull();
  },
);

it("parses what this checkout's script prints", () => {
  const script = resolve(import.meta.dirname, '../../../scripts/app-version.sh');
  const printed = execFileSync('bash', [script], { encoding: 'utf8' }).trim();
  expect(parseAppVersion(printed)).not.toBeNull();
});

it('shows the date and the commit, and says both in words', () => {
  const { container } = render(<VersionLabel version={{ date: '26.10.31', commit: '0cad4d6', dirty: false }} />);
  const sentence = t('nav.version', { date: '26.10.31', commit: '0cad4d6' });
  // Left to right in every language, so a Hebrew page does not put the hash first.
  expect(container.querySelector('[dir="ltr"]')?.textContent).toBe('26.10.31 · 0cad4d6');
  expect(screen.getByText(sentence)).toBeTruthy();
  expect(screen.getByTitle(sentence)).toBeTruthy();
});

it('marks uncommitted changes', () => {
  const { container } = render(<VersionLabel version={{ date: '26.10.31', commit: '0cad4d6', dirty: true }} />);
  expect(container.querySelector('[dir="ltr"]')?.textContent).toBe('26.10.31 · 0cad4d6*');
  expect(screen.getByText(t('nav.versionDirty', { date: '26.10.31', commit: '0cad4d6' }))).toBeTruthy();
});

it('says the version is unknown when none was built in', () => {
  render(<VersionLabel version={null} />);
  expect(screen.getByText(t('nav.versionUnknown'))).toBeTruthy();
});
