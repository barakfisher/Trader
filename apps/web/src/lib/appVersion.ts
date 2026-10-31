/**
 * The version this bundle was built from (D351), as scripts/app-version.sh
 * prints it: `26.10.31+0cad4d6`, `-dirty` appended when the checkout had
 * uncommitted changes. Written into the bundle by vite.config.ts.
 *
 * The date is the commit's (UTC), the hash names the commit itself - two merges
 * on one day share a date, never a hash - so the header can tell production
 * from a local checkout at a glance.
 */
export type AppVersion = {
  /** YY.MM.DD, the commit's date in UTC. */
  date: string;
  /** The short commit hash, what `prod-deploy.sh <commit>` takes. */
  commit: string;
  /** Built from a checkout with uncommitted changes: not that commit exactly. */
  dirty: boolean;
};

const VERSION = /^(\d{2}\.\d{2}\.\d{2})\+([0-9a-f]{7,40})(-dirty)?$/;

/** Null for anything else - an absent value included - so nothing is shown that was not built in. */
export function parseAppVersion(raw: string | undefined): AppVersion | null {
  const match = raw === undefined ? null : VERSION.exec(raw);
  if (!match) return null;
  return { date: match[1]!, commit: match[2]!, dirty: match[3] !== undefined };
}

export const APP_VERSION = parseAppVersion(import.meta.env.APP_VERSION);

declare global {
  interface ImportMetaEnv {
    /** Set by `define` in vite.config.ts; absent under Vitest. */
    readonly APP_VERSION?: string;
  }
}
