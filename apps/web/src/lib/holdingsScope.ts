/**
 * Which holdings the dashboard's cards and table show (D32, D227): everything,
 * real and simulated together (the default), the real portfolio, every
 * simulated agent, or one of them. Carried in the address as
 * `?holdings=real`, `?holdings=simulated` or `?holdings=<agent id>`, so a
 * chosen view survives a reload and can be sent; the plain address is *All*,
 * and so is `?holdings=all`, which links made before D227 carry.
 *
 * The address is typed by whoever sends a link, so anything unrecognised is the
 * default view - never an error page. An agent id that is not one of the user's
 * non-archived agents is resolved to the default by the page, which knows them.
 */

export type HoldingsScope =
  | { kind: 'all' }
  | { kind: 'real' }
  | { kind: 'simulated' }
  | { kind: 'agent'; agentId: string };

const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ALL_SCOPE: HoldingsScope = { kind: 'all' };
export const REAL_SCOPE: HoldingsScope = { kind: 'real' };

export function holdingsScopeFrom(search: unknown): HoldingsScope {
  const value = ((search ?? {}) as Record<string, unknown>).holdings;
  if (value === 'real') return REAL_SCOPE;
  if (value === 'simulated') return { kind: 'simulated' };
  if (typeof value === 'string' && AGENT_ID.test(value)) return { kind: 'agent', agentId: value.toLowerCase() };
  return ALL_SCOPE;
}

/** The address's value for a scope; undefined for the default, so the plain address means it. */
export function holdingsSearchValue(scope: HoldingsScope): string | undefined {
  if (scope.kind === 'agent') return scope.agentId;
  if (scope.kind === 'all') return undefined;
  return scope.kind;
}

/** Whether a position of this agent is in the scope. */
export function inScope(scope: HoldingsScope, position: { agentId: string; isPrimary: boolean }): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'real':
      return position.isPrimary;
    case 'simulated':
      return !position.isPrimary;
    case 'agent':
      return !position.isPrimary && position.agentId === scope.agentId;
  }
}
