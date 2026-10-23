import { describe, expect, it } from 'vitest';

import { agentFilterFrom } from '../src/components/ProposalsInbox.tsx';

describe("the inbox's agent filter (D252)", () => {
  it('reads an agent id from the address, and ignores anything else', () => {
    const id = '90000000-0000-0000-0000-0000000000A1';
    expect(agentFilterFrom({ tab: 'proposals', agent: id })).toBe(id.toLowerCase());
    expect(agentFilterFrom({ agent: 'not-an-id' })).toBeNull();
    expect(agentFilterFrom({ agent: 7 })).toBeNull();
    expect(agentFilterFrom(undefined)).toBeNull();
  });
});
