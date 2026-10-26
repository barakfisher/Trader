/**
 * The one event the API layer raises to the rest of the app: a request was
 * refused for want of a session (D261) - another device signed this one out,
 * the admin disabled the account, or the session ran out. Without it the page
 * would stay up with every panel failing until a reload.
 *
 * A module of its own rather than part of `client.ts`, so a test that replaces
 * the client still has a store that can start.
 */

let listener: (() => void) | null = null;

/** The listener decides whether it matters: a wrong password at sign-in is the same refusal while nobody is signed in. */
export function onSessionEnded(next: (() => void) | null): void {
  listener = next;
}

export function reportSessionEnded(): void {
  listener?.();
}

let legalListener: (() => void) | null = null;

/**
 * The other refusal the app must answer as a whole (D265): a new version of the
 * privacy policy and terms was published while the page was open, and the
 * server refuses everything until it is accepted.
 */
export function onLegalAcceptanceRequired(next: (() => void) | null): void {
  legalListener = next;
}

export function reportLegalAcceptanceRequired(): void {
  legalListener?.();
}
