/**
 * createGatewayTurnHandler (Feature 1, Step 4) — the ONE turn handler. Proves each
 * optional stage (mention-gate / approval / directive / serialize / stale-drop /
 * error-reply / journal) behaves so the per-channel configs reproduce their exact
 * old behaviour from a single implementation.
 */
import { describe, it, expect, vi } from 'vitest';
import { createGatewayTurnHandler, type GatewayTurnDeps } from '../../src/core/channels/gateway-turn-handler.js';
import type { UnifiedMessage } from '../../src/core/channels/types.js';

function baseDeps(over: Partial<GatewayTurnDeps> = {}): GatewayTurnDeps {
  return {
    sessionManager: {
      getOrCreate: vi.fn(async () => ({ id: 'sess-1' })),
      appendEvent: vi.fn(async () => {}),
      peerQueue: { enqueue: vi.fn(async (_k: string, fn: () => Promise<void>) => { await fn(); }) },
    },
    agentLoop: { run: vi.fn(async () => ({ text: 'the reply' })) },
    runGenerations: { current: vi.fn(() => 1), isStale: vi.fn(() => false) },
    send: vi.fn(async () => {}),
    ...over,
  };
}
function msg(text = 'hello'): UnifiedMessage {
  return { id: 'm1', channel: 'discord', peerId: 'p1', peerName: 'p1', chatType: 'dm', text, timestamp: new Date() };
}

describe('createGatewayTurnHandler', () => {
  it('runs a turn and sends the reply', async () => {
    const d = baseDeps();
    await createGatewayTurnHandler(d)(msg());
    // caller identity is bound to the turn (isOwner false — msg has no isOwner).
    // onEvent is the progress bridge (activity-timeline seam), always supplied.
    expect(d.agentLoop.run).toHaveBeenCalledWith('sess-1', 'hello', expect.any(Function), {
      race: true,
      caller: { isOwner: false, channel: 'discord', peerId: 'p1' },
    });
    expect(d.send).toHaveBeenCalledWith(expect.objectContaining({ peerId: 'p1' }), 'the reply');
  });

  it('threads isOwner=true when the message is from the owner', async () => {
    const d = baseDeps();
    await createGatewayTurnHandler(d)({ ...msg(), isOwner: true });
    expect(d.agentLoop.run).toHaveBeenCalledWith('sess-1', 'hello', expect.any(Function), {
      race: true,
      caller: { isOwner: true, channel: 'discord', peerId: 'p1' },
    });
  });

  it('bridges agent events onto the progress broadcaster keyed by channel:peerId', async () => {
    const { progress } = await import('../../src/core/gateway/progress.js');
    const seen: Array<{ type: string; tool?: string; ok?: boolean }> = [];
    const unsub = progress.subscribe('discord:p1', (ev) => seen.push({ type: ev.type, tool: ev.tool, ok: ev.ok }));
    try {
      const d = baseDeps({
        agentLoop: {
          run: vi.fn(async (_s: string, _t: string, onEvent?: (ev: unknown) => void) => {
            onEvent?.({ type: 'tool-call', name: 'web.search', args: {}, toolId: 't1' });
            onEvent?.({ type: 'tool-result', name: 'web.search', result: 'ok', toolId: 't1', success: true });
            onEvent?.({ type: 'tool-result', name: 'web.fetch', result: 'nope', toolId: 't2', success: false });
            return { text: 'the reply' };
          }) as unknown as GatewayTurnDeps['agentLoop']['run'],
        },
      });
      await createGatewayTurnHandler(d)(msg());
      expect(seen).toEqual([
        { type: 'tool_call', tool: 'web.search', ok: undefined },
        { type: 'tool_result', tool: 'web.search', ok: true },
        { type: 'tool_result', tool: 'web.fetch', ok: false },
        { type: 'complete', tool: undefined, ok: undefined },
      ]);
    } finally {
      unsub();
    }
  });

  it('drops a stale reply after a mid-turn /reset', async () => {
    const d = baseDeps({ runGenerations: { current: () => 1, isStale: () => true } });
    await createGatewayTurnHandler(d)(msg());
    expect(d.send).not.toHaveBeenCalled();
  });

  it('approval reply short-circuits before any turn', async () => {
    const d = baseDeps({ approvalConsume: vi.fn(() => true) });
    await createGatewayTurnHandler(d)(msg('yes'));
    expect(d.agentLoop.run).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it('slash directive short-circuits the turn', async () => {
    const directiveDispatch = vi.fn(async () => true);
    const d = baseDeps({ directiveDispatch });
    await createGatewayTurnHandler(d)(msg('/stop'));
    expect(directiveDispatch).toHaveBeenCalled();
    expect(d.agentLoop.run).not.toHaveBeenCalled();
  });

  it('mention gate ignores non-addressed group messages', async () => {
    const d = baseDeps({ mentionGate: () => false });
    await createGatewayTurnHandler(d)(msg());
    expect(d.agentLoop.run).not.toHaveBeenCalled();
  });

  it('sends the error text when the turn throws', async () => {
    const d = baseDeps({ agentLoop: { run: vi.fn(async () => { throw new Error('boom'); }) }, errorText: 'oops' });
    await createGatewayTurnHandler(d)(msg());
    expect(d.send).toHaveBeenCalledWith(expect.anything(), 'oops');
  });

  it('serialize:true routes through the peerQueue; serialize:false runs direct', async () => {
    const dQueued = baseDeps({ serialize: true });
    await createGatewayTurnHandler(dQueued)(msg());
    expect(dQueued.sessionManager.peerQueue.enqueue).toHaveBeenCalled();

    const dDirect = baseDeps({ serialize: false });
    await createGatewayTurnHandler(dDirect)(msg());
    expect(dDirect.sessionManager.peerQueue.enqueue).not.toHaveBeenCalled();
    expect(dDirect.send).toHaveBeenCalledWith(expect.anything(), 'the reply');
  });

  it('appends journal events by default and skips daily-log for flagged peers', async () => {
    const dailyLog = { append: vi.fn(async () => {}) };
    const d = baseDeps({ dailyLog, shouldSkipDailyLog: () => true });
    await createGatewayTurnHandler(d)(msg());
    expect(d.sessionManager.appendEvent).toHaveBeenCalledTimes(2); // user + assistant
    expect(dailyLog.append).not.toHaveBeenCalled(); // skipped
  });
});
