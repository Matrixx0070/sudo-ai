/**
 * email.search / email.read / email.reply tools (Spec 5 step 4).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { emailSearchTool, emailReadTool, emailReplyTool } from '../../src/core/tools/builtin/comms/email-inbox.js';
import { registerEmailBridge, __resetEmailBridgeForTests } from '../../src/core/channels/email-bridge.js';
import type { ToolContext } from '../../src/core/tools/types.js';

const ctx = { sessionId: 's', workingDir: '/tmp', config: null, logger: console } as unknown as ToolContext;

beforeEach(() => __resetEmailBridgeForTests());

describe('email inbox tools', () => {
  it('report "not connected" when the bridge is unwired', async () => {
    const r = await emailSearchTool.execute({ from: 'x@y.com' }, ctx);
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/not connected/i);
  });

  it('email.search lists matches via the bridge', async () => {
    registerEmailBridge({
      search: async () => [{ uid: 7, from: 'a@b.com', subject: 'Hi', date: '2026-01-01T00:00:00Z', snippet: 'hello there' }],
      read: async () => null,
      reply: async () => ({ ok: true, drafted: true }),
    });
    const r = await emailSearchTool.execute({ subject: 'Hi' }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('uid 7');
    expect(r.output).toContain('hello there');
  });

  it('email.read returns the plaintext body + requires a numeric uid', async () => {
    registerEmailBridge({
      search: async () => [],
      read: async (uid) => (uid === 7 ? { uid: 7, from: 'a@b.com', to: 'me@x.com', subject: 'Hi', date: 'D', text: 'BODY', attachments: ['data/email/t/x.pdf'] } : null),
      reply: async () => ({ ok: true, drafted: true }),
    });
    const bad = await emailReadTool.execute({}, ctx);
    expect(bad.success).toBe(false);
    const ok = await emailReadTool.execute({ uid: 7 }, ctx);
    expect(ok.success).toBe(true);
    expect(ok.output).toContain('BODY');
    expect(ok.output).toContain('x.pdf');
  });

  it('email.reply reports draft vs sent from the bridge', async () => {
    const reply = vi.fn(async () => ({ ok: true, drafted: true }));
    registerEmailBridge({ search: async () => [], read: async () => null, reply });
    const r = await emailReplyTool.execute({ to: 'thread-1', text: 'hi' }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/draft/i);
    expect(reply).toHaveBeenCalledWith('thread-1', 'hi');

    const missing = await emailReplyTool.execute({ to: '' }, ctx);
    expect(missing.success).toBe(false);
  });
});
