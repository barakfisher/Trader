/**
 * The privacy policy and terms as written (D265): one Markdown file per
 * document and language beside this module, bundled with the app so the pages
 * open signed out and with the API down. The Hebrew is its own text, never a
 * translation of the English - a translated legal text is a different
 * document - so there is no fallback from one language to the other: a
 * missing file fails `legalText.test.ts`, not a reader.
 */

import { LEGAL_TEXT_PENDING_MARKER, type LegalDocument, type UiLanguage } from '@traders/shared';

const FILES = import.meta.glob<string>('./*/*.md', { query: '?raw', import: 'default', eager: true });

/** The file's text as written, the pending marker included. */
export function legalSource(language: UiLanguage, document: LegalDocument): string | undefined {
  return FILES[`./${language}/${document}.md`];
}

/** The text a page renders: the marker is for the build's check, not the reader. */
export function legalText(language: UiLanguage, document: LegalDocument): string {
  return (legalSource(language, document) ?? '').replace(LEGAL_TEXT_PENDING_MARKER, '').trim();
}

/** Where each document is read, signed in or out. */
export function legalPath(document: LegalDocument): string {
  return `/${document}`;
}
