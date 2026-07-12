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
    expect(d.agentLoop.run).toHaveBeenCalledWith('sess-1', 'hello', undefined, { race: true });
    expect(d.send).toHaveBeenCalledWith(expect.objectContaining({ peerId: 'p1' }), 'the reply');
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
