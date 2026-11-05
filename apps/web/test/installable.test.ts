/**
 * What a browser needs before it will install the app rather than add a shortcut
 * that opens with an address bar (D391). These files are read by the browser
 * alone, so nothing else in the suite would notice one going missing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const WEB_ROOT = resolve(import.meta.dirname, '..');
const PUBLIC_DIR = resolve(WEB_ROOT, 'public');
const THEME = readFileSync(resolve(WEB_ROOT, 'src/index.css'), 'utf8').match(/--color-surface: (#[0-9a-f]{6});/)?.[1];
const INDEX = readFileSync(resolve(WEB_ROOT, 'index.html'), 'utf8');

interface ManifestIcon {
  src: string;
  sizes: string;
  purpose: string;
}

const manifest = JSON.parse(readFileSync(resolve(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8')) as {
  display: string;
  start_url: string;
  scope: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
};

/** A PNG's width and height are big-endian at fixed offsets of its header chunk. */
function pngSize(path: string): string {
  const bytes = readFileSync(path);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

describe('the installed app', () => {
  it('is linked from the page', () => {
    expect(INDEX).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it('opens without the browser around it, on the whole app', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
  });

  it('starts in the page\'s own colour, so opening it does not flash', () => {
    expect(THEME).toBeDefined();
    expect(manifest.background_color).toBe(THEME);
    expect(manifest.theme_color).toBe(THEME);
    expect(INDEX).toContain(`<meta name="theme-color" content="${THEME}" />`);
  });

  it('lists the sizes an install requires, and each icon is the size it claims', () => {
    const sizes = manifest.icons.filter((icon) => icon.purpose === 'any').map((icon) => icon.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const icon of manifest.icons) {
      expect(pngSize(resolve(PUBLIC_DIR, `.${icon.src}`))).toBe(icon.sizes);
    }
  });

  it('has an icon a launcher may crop to its own shape', () => {
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  });

  it('has the icon an iPhone looks for', () => {
    expect(INDEX).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(existsSync(resolve(PUBLIC_DIR, 'apple-touch-icon.png'))).toBe(true);
  });
});
