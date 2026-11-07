/** The signed buttons under a drafted proposal in Telegram (D393). */

import { describe, expect, it } from 'vitest';

import { decodeAgentActionData } from '../src/telegram/agentActionToken.js';
import { decodeAssistantDraftData, encodeAssistantDraftData } from '../src/telegram/assistantDraftToken.js';
import { MAX_CALLBACK_DATA_BYTES, decodeCallbackData } from '../src/telegram/callbackToken.js';

const SECRET = 'a-signing-secret-long-enough';
const MESSAGE = '80000000-0000-0000-0000-000000000001';

describe('a drafted proposal button', () => {
  it('round-trips within what Telegram accepts', () => {
    for (const action of ['add', 'close'] as const) {
      const data = encodeAssistantDraftData({ messageId: MESSAGE, action }, SECRET);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(MAX_CALLBACK_DATA_BYTES);
      expect(decodeAssistantDraftData(data, SECRET)).toEqual({ messageId: MESSAGE, action });
    }
  });

  it('refuses another secret, and an edited action', () => {
    const data = encodeAssistantDraftData({ messageId: MESSAGE, action: 'close' }, SECRET);
    expect(decodeAssistantDraftData(data, 'another-secret-entirely-here')).toBeNull();
    expect(decodeAssistantDraftData(data.replace('c.', 'a.'), SECRET)).toBeNull();
  });

  it("is no other button's token: each is signed under its own domain", () => {
    const data = encodeAssistantDraftData({ messageId: MESSAGE, action: 'add' }, SECRET);
    expect(decodeAgentActionData(data, SECRET)).toBeNull();
    expect(decodeCallbackData(data, SECRET)).toBeNull();
  });
});
