/**
 * @file tests/channels/gmail.test.ts
 * @description Tests for gmail-connector.ts — graceful stub behavior.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('gmail-connector (no vault credential configured)', () => {
  it('listGmailMessages returns success=false with helpful message', async () => {
    const { listGmailMessages } = await import('../../src/core/channels/gmail-connector.js');
    const result = await listGmailMessages(5);
    expect(result.success).toBe(false);
    expect(result.output).toContain('not configured in vault');
  });

  it('sendGmailMessage returns success=false with helpful message', async () => {
    const { sendGmailMessage } = await import('../../src/core/channels/gmail-connector.js');
    const result = await sendGmailMessage('to@example.com', 'subject', 'body');
    expect(result.success).toBe(false);
    expect(result.output).toContain('not configured in vault');
  });

  it('sendGmailMessage validates required fields when called', async () => {
    const { sendGmailMessage } = await import('../../src/core/channels/gmail-connector.js');
    // Even with missing fields, should return graceful error not throw
    const result = await sendGmailMessage('', '', '');
    expect(result.success).toBe(false);
  });
});

describe('comms.gmail tool', () => {
  it('returns error for invalid operation', async () => {
    const { gmailTool } = await import('../../src/core/tools/builtin/comms/gmail.js');
    const result = await gmailTool.execute(
      { operation: 'invalid' },
      { sessionId: 'test', signal: undefined } as unknown as Parameters<typeof gmailTool.execute>[1],
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('operation');
  });

  it('list operation passes through gracefully', async () => {
    const { gmailTool } = await import('../../src/core/tools/builtin/comms/gmail.js');
    const result = await gmailTool.execute(
      { operation: 'list', max_results: 5 },
      { sessionId: 'test', signal: undefined } as unknown as Parameters<typeof gmailTool.execute>[1],
    );
    expect(result.success).toBe(false); // googleapis not installed
    expect(result.output).toBeDefined();
  });

  it('send operation validates required fields', async () => {
    const { gmailTool } = await import('../../src/core/tools/builtin/comms/gmail.js');
    const result = await gmailTool.execute(
      { operation: 'send' }, // missing to/subject/body
      { sessionId: 'test', signal: undefined } as unknown as Parameters<typeof gmailTool.execute>[1],
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('"to"');
  });
});
