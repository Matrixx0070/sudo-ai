/**
 * @file tests/channels/imessage.test.ts
 * @description Tests for imessage-connector.ts — platform guard and read operations.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('imessage-connector — Linux platform (supported=false)', () => {
  it('listIMessageConversations returns supported=false on Linux', async () => {
    // process.platform is 'linux' in this test environment
    const { listIMessageConversations } = await import('../../src/core/channels/imessage-connector.js');
    const result = await listIMessageConversations(10);
    expect(result.supported).toBe(false);
    expect(result.output).toContain('macOS');
  });

  it('readIMessageChat returns supported=false on Linux', async () => {
    const { readIMessageChat } = await import('../../src/core/channels/imessage-connector.js');
    const result = await readIMessageChat(1, 10);
    expect(result.supported).toBe(false);
    expect(result.output).toContain('macOS');
  });
});

describe('comms.imessage tool — Linux', () => {
  it('list operation returns success=false on Linux', async () => {
    const { imessageTool } = await import('../../src/core/tools/builtin/comms/imessage.js');
    const result = await imessageTool.execute(
      { operation: 'list', limit: 10 },
      { sessionId: 'test', signal: undefined } as unknown as Parameters<typeof imessageTool.execute>[1],
    );
    expect(result.success).toBe(false);
  });

  it('read operation validates chat_id', async () => {
    const { imessageTool } = await import('../../src/core/tools/builtin/comms/imessage.js');
    const result = await imessageTool.execute(
      { operation: 'read' }, // missing chat_id
      { sessionId: 'test', signal: undefined } as unknown as Parameters<typeof imessageTool.execute>[1],
    );
    expect(result.success).toBe(false);
    // On Linux: returns unsupported first; on macOS: would validate chat_id
  });

  it('invalid operation returns error', async () => {
    const { imessageTool } = await import('../../src/core/tools/builtin/comms/imessage.js');
    const result = await imessageTool.execute(
      { operation: 'send' }, // invalid
      { sessionId: 'test', signal: undefined } as unknown as Parameters<typeof imessageTool.execute>[1],
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('operation');
  });

  it('tool has correct category', async () => {
    const { imessageTool } = await import('../../src/core/tools/builtin/comms/imessage.js');
    expect(imessageTool.category).toBe('comms');
    expect(imessageTool.name).toBe('comms.imessage');
  });
});
