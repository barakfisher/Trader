/**
 * The privacy policy and the terms (D265).
 *
 * The text lives in the web app, one Markdown file per document and language
 * (`apps/web/src/legal/<language>/<document>.md`); the Hebrew is its own text,
 * never a translation. What the server needs is only which version is
 * current, so the version lives here, beside nothing else.
 *
 * **`null` means the text is pending:** the files are placeholders, nobody is
 * asked to accept anything, and a production installation keeps public
 * sign-up closed (the gate). Publishing the text is three edits in one
 * commit, which the web's `legalText.test.ts` holds together:
 * 1. write the four files and remove `LEGAL_TEXT_PENDING_MARKER` from each;
 * 2. set this to the publication date, `YYYY-MM-DD`;
 * 3. nothing else - every user who has not accepted that version is asked to
 *    at their next request, and sign-up stores it.
 *
 * A later change that people must agree to again sets a new date. A typo fix
 * that changes nothing agreed may keep the date; that is the editor's call.
 */
export const LEGAL_VERSION: string | null = null;

/** The documents, each a page at `/<document>` reachable signed out. */
export const LEGAL_DOCUMENTS = ['privacy', 'terms'] as const;
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];

/** A placeholder file carries this line, and a published one must not. */
export const LEGAL_TEXT_PENDING_MARKER = '<!-- legal-text-pending -->';

/** What a version looks like: the date it was published. Also the table's CHECK (0077). */
export const LEGAL_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The session gate's refusal while the current version is not accepted. */
export const LEGAL_ACCEPTANCE_REQUIRED = 'legal_acceptance_required';

/** `POST /auth/legal/accept`: the version the person read, which must still be current. */
export interface LegalAcceptanceInput {
  version: string;
}
