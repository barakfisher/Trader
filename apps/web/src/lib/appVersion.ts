/**
 * The version this bundle was built from (D351, D352), as scripts/app-version.sh
 * prints it: `2026-10-31T16:12:41Z+c2a9e55`, `-dirty` appended when the
 * checkout had uncommitted changes. Written into the bundle by vite.config.ts.
 *
 * The header shows when the commit landed, on the user's own clock - easier to
 * read and to compare than a hash, and two merges a minute apart are not how
 * this repository works. The hash stays for the tooltip: it is what
 * `prod-deploy.sh <commit>` takes.
 */
export type AppVersion = {
  /** When the commit was made, ISO 8601 UTC - for a squash merge, when it reached main. */
  committedAt: string;
  /** The short commit hash. */
  commit: string;
  /** Built from a checkout with uncommitted changes: not that commit exactly. */
  dirty: boolean;
};

const VERSION = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\+([0-9a-f]{7,40})(-dirty)?$/;

/** Null for anything else - an absent value included - so nothing is shown that was not built in. */
export function parseAppVersion(raw: string | undefined): AppVersion | null {
  const match = raw === undefined ? null : VERSION.exec(raw);
  if (!match || Number.isNaN(Date.parse(match[1]!))) return null;
  return { committedAt: match[1]!, commit: match[2]!, dirty: match[3] !== undefined };
}

/**
 * `26.10.31` and `18:12`, in the given zone. A fixed pattern rather than the
 * language's date format: it is a label to compare at a glance, the same in
 * every language, as the user asked for it.
 */
export function versionStamp(committedAt: string, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(committedAt));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${part('year')}.${part('month')}.${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

export const APP_VERSION = parseAppVersion(import.meta.env.APP_VERSION);

declare global {
  interface ImportMetaEnv {
    /** Set by `define` in vite.config.ts; absent under Vitest. */
    readonly APP_VERSION?: string;
  }
}
