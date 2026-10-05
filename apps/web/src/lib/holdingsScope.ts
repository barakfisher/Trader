/**
 * Which holdings the dashboard's holdings card and headline show (D32, D33):
 * the real portfolio (the default), everything consolidated, or one simulated
 * agent. Carried in the address as `?holdings=all` or `?holdings=<agent id>`,
 * so a chosen view survives a reload and can be sent.
 *
 * The address is typed by whoever sends a link, so anything unrecognised is the
 * default view - never an error page. An agent id that is not one of the user's
 * non-archived agents is resolved to the default by the page, which knows them.
 */

export type HoldingsScope = { kind: 'real' } | { kind: 'all' } | { kind: 'agent'; agentId: string };

const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const REAL_SCOPE: HoldingsScope = { kind: 'real' };

export function holdingsScopeFrom(search: unknown): HoldingsScope {
  const value = ((search ?? {}) as Record<string, unknown>).holdings;
  if (value === 'all') return { kind: 'all' };
  if (typeof value === 'string' && AGENT_ID.test(value)) return { kind: 'agent', agentId: value.toLowerCase() };
  return REAL_SCOPE;
}

/** The address's value for a scope; undefined for the default, so the plain address means it. */
export function holdingsSearchValue(scope: HoldingsScope): string | undefined {
  if (scope.kind === 'all') return 'all';
  if (scope.kind === 'agent') return scope.agentId;
  return undefined;
}
