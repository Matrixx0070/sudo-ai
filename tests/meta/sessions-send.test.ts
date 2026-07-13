/**
 * sessions.send tool (Spec 6) — ACL, unknown target, deliver, waitForReply, hop.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sessionsSendTool } from '../../src/core/tools/builtin/meta/sessions-send.js';
import { injectMetaToolDeps } from '../../src/core/tools/builtin/meta/index.js';
import { setSendChain, getSendChain, markInflight, __resetSessionBusForTests, __resetQueueForTests, MAX_HOP_DEPTH } from '../../src/core/agents/session-bus.js';
import type { ToolContext } from '../../src/core/tools/types.js';

const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({ sessionId: 'A', workingDir: '/tmp', config: null, logger: console, isOwner: true, channel: 'web', ...over } as unknown as ToolContext);

let run: ReturnType<typeof vi.fn>;
beforeEach(() => {
  __resetSessionBusForTests();
  __resetQueueForTests();
  run = vi.fn(async () => ({ text: 'reply from B' }));
  injectMetaToolDeps({
    sessionManager: { get: async (id: string) => (id === 'B' ? { id: 'B' } : undefined) },
    agentLoop: { run },
  });
});

describe('sessions.send', () => {
  it('refuses a known non-owner session (ACL)', async () => {
    const r = await sessionsSendTool.execute({ targetSessionId: 'B', message: 'hi' }, ctx({ isOwner: false }));
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/owner-tier/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('errors on an unknown target', async () => {
    const r = await sessionsSendTool.execute({ targetSessionId: 'ghost', message: 'hi' }, ctx());
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/unknown target/i);
  });

  it('fire-and-forget delivers via agentLoop.run with an envelope + owner-inherited caller', async () => {
    const r = await sessionsSendTool.execute({ targetSessionId: 'B', message: 'Findings: X' }, ctx());
    expect(r.success).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    const [sid, msg, , opts] = run.mock.calls[0]!;
    expect(sid).toBe('B');
    expect(msg).toContain('[inter-agent message from session:A');
    expect(msg).toContain('Findings: X');
    expect(opts).toMatchObject({ caller: { isOwner: true, channel: 'session', peerId: 'A' } });
  });

  it('waitForReply returns the target reply', async () => {
    const r = await sessionsSendTool.execute({ targetSessionId: 'B', message: 'q', waitForReply: true }, ctx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('reply from B');
  });

  it('waitForReply times out cleanly', async () => {
    run.mockImplementation(() => new Promise(() => {})); // never resolves
    const r = await sessionsSendTool.execute({ targetSessionId: 'B', message: 'q', waitForReply: true, timeoutMs: 30 }, ctx());
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/no reply within/i);
    expect(r.data).toMatchObject({ timedOut: true });
  });

  it('blocks when the sender is already at the hop-depth limit', async () => {
    setSendChain('A', { depth: MAX_HOP_DEPTH, chain: ['x', 'y', 'z', 'A'] });
    const r = await sessionsSendTool.execute({ targetSessionId: 'B', message: 'hi' }, ctx());
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/hop-depth/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('GAP A: clears the target chain after the delivered turn (no stale poisoning)', async () => {
    await sessionsSendTool.execute({ targetSessionId: 'B', message: 'hi', waitForReply: true }, ctx());
    // After delivery completes, B must be back to a root chain, not {depth:1,[A,B]}.
    expect(getSendChain('B')).toEqual({ depth: 0, chain: ['B'] });
  });

  it('GAP B: a BUSY target is queued, not run concurrently', async () => {
    markInflight('B'); // simulate B already running
    const r = await sessionsSendTool.execute({ targetSessionId: 'B', message: 'hi' }, ctx());
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/busy/i);
    expect(r.data).toMatchObject({ queued: true, busy: true });
    expect(run).not.toHaveBeenCalled();
  });
});
