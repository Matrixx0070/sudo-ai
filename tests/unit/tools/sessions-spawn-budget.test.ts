// Unit tests for sessions.spawn budget enforcement (Session 19).
// Covers: depth limit, per-session count cap, global concurrent cap,
// env-var overrides, announce-back regression, pre-existing session handling.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { injectMetaToolDeps } from '../../../src/core/tools/builtin/meta/index.js';
import {
  sessionsSpawnTool,
  _resetBudgetState,
} from '../../../src/core/tools/builtin/meta/sessions-spawn.js';
import { makeToolContext } from '../../helpers/mocks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps() {
  const mockLoop = { run: vi.fn(async () => ({ text: 'task done' })) };
  const mockSessionManager = {
    getOrCreate: vi.fn(async (_ch: string, peer: string) => ({ id: `sess-${peer}-${Date.now()}` })),
  };
  const mockChannelRouter = { send: vi.fn(async () => undefined) };
  injectMetaToolDeps({ agentLoop: mockLoop, sessionManager: mockSessionManager, channelRouter: mockChannelRouter });
  return { mockLoop, mockSessionManager, mockChannelRouter };
}

function clearDeps(): void {
  injectMetaToolDeps({
    sessionManager: null,
    agentLoop: null,
    cronManager: null,
    channelRouter: null,
    memoryEngine: null,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetBudgetState();
  clearDeps();
});

afterEach(() => {
  _resetBudgetState();
  clearDeps();
});

// ---------------------------------------------------------------------------
// Depth limit tests
// ---------------------------------------------------------------------------

describe('sessions.spawn — depth budget', () => {
  it('spawns successfully from a root (depth 0) session and child gets depth 1', async () => {
    makeDeps();
    const ctx = makeToolContext({ sessionId: 'root-session' });

    const result = await sessionsSpawnTool.execute({ task: 'depth-0 task' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ depth: 1 });
  });

  it('allows spawn when current depth is MAX_SPAWN_DEPTH - 1 (depth 2 by default)', async () => {
    // Simulate a session at depth MAX-1 = 2 (default max is 3)
    // We need to prime the depth map; do it by chaining spawns.
    const { mockSessionManager } = makeDeps();

    // Spawn chain: root → depth1 → depth2
    const sessionIds: string[] = [];
    mockSessionManager.getOrCreate.mockImplementation(async (_ch: string, peer: string) => {
      const id = `sess-${peer}-${sessionIds.length}`;
      sessionIds.push(id);
      return { id };
    });

    const rootCtx = makeToolContext({ sessionId: 'chain-root' });

    // First spawn: root (depth 0) → child (depth 1)
    const r1 = await sessionsSpawnTool.execute({ task: 'step 1', announceBack: false }, rootCtx);
    expect(r1.success).toBe(true);
    const depth1Id = (r1.data as Record<string, unknown>)['sessionId'] as string;

    // Second spawn: depth-1 session → child (depth 2)
    const depth1Ctx = makeToolContext({ sessionId: depth1Id });
    const r2 = await sessionsSpawnTool.execute({ task: 'step 2', announceBack: false }, depth1Ctx);
    expect(r2.success).toBe(true);
    expect((r2.data as Record<string, unknown>)['depth']).toBe(2);
  });

  it('rejects a spawn when current depth equals MAX_SPAWN_DEPTH (default 3)', async () => {
    // Manually prime depth map by chaining 3 successful spawns then attempting a 4th
    const { mockSessionManager } = makeDeps();
    let counter = 0;
    mockSessionManager.getOrCreate.mockImplementation(async (_ch: string, peer: string) => {
      return { id: `chain-sess-${++counter}-${peer}` };
    });

    // Build the chain root → 1 → 2 → 3
    const rootCtx = makeToolContext({ sessionId: 'depth-root' });
    const r1 = await sessionsSpawnTool.execute({ task: 'step 1', announceBack: false }, rootCtx);
    expect(r1.success).toBe(true);
    const d1Id = (r1.data as Record<string, unknown>)['sessionId'] as string;

    const d1Ctx = makeToolContext({ sessionId: d1Id });
    const r2 = await sessionsSpawnTool.execute({ task: 'step 2', announceBack: false }, d1Ctx);
    expect(r2.success).toBe(true);
    const d2Id = (r2.data as Record<string, unknown>)['sessionId'] as string;

    const d2Ctx = makeToolContext({ sessionId: d2Id });
    const r3 = await sessionsSpawnTool.execute({ task: 'step 3', announceBack: false }, d2Ctx);
    expect(r3.success).toBe(true);
    const d3Id = (r3.data as Record<string, unknown>)['sessionId'] as string;

    // Attempt spawn from depth-3 session — should be rejected
    const d3Ctx = makeToolContext({ sessionId: d3Id });
    const r4 = await sessionsSpawnTool.execute({ task: 'step 4', announceBack: false }, d3Ctx);

    expect(r4.success).toBe(false);
    expect(r4.output).toMatch(/depth limit reached/i);
    expect(r4.output).toContain('3');   // current depth
    expect(r4.output).toMatch(/unwind/i);
  });

  it('treats a session with no depth entry (pre-existing) as depth 0', async () => {
    makeDeps();
    // 'legacy-session' has never been in the depth map (simulates pre-existing session)
    const ctx = makeToolContext({ sessionId: 'legacy-session-no-depth' });
    const result = await sessionsSpawnTool.execute({ task: 'legacy task', announceBack: false }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>)['depth']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Per-session count limit tests
// ---------------------------------------------------------------------------

describe('sessions.spawn — per-session count budget', () => {
  it('allows up to MAX_SPAWNS_PER_SESSION (default 10) spawns from one session', async () => {
    const { mockSessionManager } = makeDeps();
    let counter = 0;
    mockSessionManager.getOrCreate.mockImplementation(async () => ({ id: `sess-${++counter}` }));

    const ctx = makeToolContext({ sessionId: 'heavy-parent' });

    for (let i = 0; i < 10; i++) {
      const r = await sessionsSpawnTool.execute({ task: `task-${i}`, announceBack: false }, ctx);
      expect(r.success).toBe(true);
    }
  });

  it('rejects the 11th spawn from the same session', async () => {
    const { mockSessionManager } = makeDeps();
    let counter = 0;
    mockSessionManager.getOrCreate.mockImplementation(async () => ({ id: `sess-${++counter}` }));

    const ctx = makeToolContext({ sessionId: 'heavy-parent-2' });

    for (let i = 0; i < 10; i++) {
      await sessionsSpawnTool.execute({ task: `task-${i}`, announceBack: false }, ctx);
    }

    const r11 = await sessionsSpawnTool.execute({ task: 'overflow-task', announceBack: false }, ctx);

    expect(r11.success).toBe(false);
    expect(r11.output).toMatch(/spawn limit reached/i);
    expect(r11.output).toContain('10');
  });

  it('independent sessions each have their own count — second session is not blocked', async () => {
    const { mockSessionManager } = makeDeps();
    let counter = 0;
    mockSessionManager.getOrCreate.mockImplementation(async () => ({ id: `sess-${++counter}` }));

    const ctx1 = makeToolContext({ sessionId: 'parent-A' });
    const ctx2 = makeToolContext({ sessionId: 'parent-B' });

    // Exhaust parent-A's budget
    for (let i = 0; i < 10; i++) {
      await sessionsSpawnTool.execute({ task: `task-${i}`, announceBack: false }, ctx1);
    }

    // parent-B should still be allowed
    const rB = await sessionsSpawnTool.execute({ task: 'parent-B task', announceBack: false }, ctx2);
    expect(rB.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Global concurrent spawn cap test
// ---------------------------------------------------------------------------

describe('sessions.spawn — global concurrent cap', () => {
  it('rejects the 21st concurrent spawn when cap is 20', async () => {
    let sc = 0;
    injectMetaToolDeps({
      agentLoop: { run: vi.fn(() => new Promise<{ text: string }>(() => { /* never resolves */ })) },
      sessionManager: { getOrCreate: vi.fn(async () => ({ id: `bs-${++sc}` })) },
    });
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      pending.push(sessionsSpawnTool.execute({ task: `t-${i}`, announceBack: false }, makeToolContext({ sessionId: `cp-${i}` })));
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    const r21 = await sessionsSpawnTool.execute({ task: 'overflow', announceBack: false }, makeToolContext({ sessionId: 'overflow' }));
    expect(r21.success).toBe(false);
    expect(r21.output).toMatch(/too many concurrent/i);
    expect(r21.output).toMatch(/try again/i);
    void pending;
  });
});

// ---------------------------------------------------------------------------
// Announce-back still works after budget enforcement (regression guard)
// ---------------------------------------------------------------------------

describe('sessions.spawn — announce-back regression', () => {
  it('sends announce-back after a successful spawn within budget', async () => {
    const { mockChannelRouter } = makeDeps();
    const result = await sessionsSpawnTool.execute(
      { task: 'announce task', channel: 'telegram', peerId: 'peer-1', announceBack: true },
      makeToolContext({ sessionId: 'announce-parent' }),
    );
    expect(result.success).toBe(true);
    expect(mockChannelRouter.send).toHaveBeenCalledOnce();
    const [ch, peer, text] = mockChannelRouter.send.mock.calls[0] as [string, string, string];
    expect(ch).toBe('telegram');
    expect(peer).toBe('announce-parent');
    expect(text).toMatch(/Sub-agent result for:/);
  });

  it('suppresses announce-back when announceBack is false', async () => {
    const { mockChannelRouter } = makeDeps();
    await sessionsSpawnTool.execute({ task: 'silent task', announceBack: false }, makeToolContext({ sessionId: 'no-announce' }));
    expect(mockChannelRouter.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// _resetBudgetState — state isolation between tests
// ---------------------------------------------------------------------------

describe('_resetBudgetState', () => {
  it('clears state so a previously-blocked session becomes unblocked', async () => {
    // Prime: session already at depth 3 (blocked) via direct counter exhaust
    const { mockSessionManager } = makeDeps();
    let cnt = 0;
    mockSessionManager.getOrCreate.mockImplementation(async () => ({ id: `rs-${++cnt}` }));
    const root = makeToolContext({ sessionId: 'rs-root' });
    const r1 = await sessionsSpawnTool.execute({ task: 't1', announceBack: false }, root);
    const r2 = await sessionsSpawnTool.execute({ task: 't2', announceBack: false }, makeToolContext({ sessionId: (r1.data as Record<string, unknown>)['sessionId'] as string }));
    const r3 = await sessionsSpawnTool.execute({ task: 't3', announceBack: false }, makeToolContext({ sessionId: (r2.data as Record<string, unknown>)['sessionId'] as string }));
    const deepId = (r3.data as Record<string, unknown>)['sessionId'] as string;
    expect((await sessionsSpawnTool.execute({ task: 'x', announceBack: false }, makeToolContext({ sessionId: deepId }))).success).toBe(false);
    _resetBudgetState();
    makeDeps();
    expect((await sessionsSpawnTool.execute({ task: 'after reset', announceBack: false }, makeToolContext({ sessionId: deepId }))).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HIGH: Race condition fix — concurrent cap enforced atomically
// ---------------------------------------------------------------------------

describe('sessions.spawn — race condition: concurrent cap enforced atomically', () => {
  it('never exceeds MAX_CONCURRENT_SPAWNS=20 across 100 simultaneous spawn() calls', async () => {
    // getOrCreate resolves instantly but agentLoop.run never resolves,
    // so concurrent spawns stay "in flight" for the duration of the test.
    let sc = 0;
    let peakConcurrent = 0;
    let currentRunning = 0;

    const slowRun = vi.fn(() => new Promise<{ text: string }>(() => {
      // Increment running count at the point the promise is created (i.e. when
      // the spawn actually starts running, after budget commits).
      currentRunning++;
      if (currentRunning > peakConcurrent) peakConcurrent = currentRunning;
      // Never resolves — keeps the slot occupied
    }));

    injectMetaToolDeps({
      agentLoop: { run: slowRun },
      sessionManager: { getOrCreate: vi.fn(async () => ({ id: `race-${++sc}` })) },
    });

    // Fire 100 concurrent spawn() calls from distinct sessions
    const calls = Array.from({ length: 100 }, (_, i) =>
      sessionsSpawnTool.execute(
        { task: `race-task-${i}`, announceBack: false },
        makeToolContext({ sessionId: `race-parent-${i}` }),
      ),
    );

    // Yield the microtask queue so the synchronous budget increments all commit
    // before the awaits inside spawn() resume.
    await new Promise<void>(resolve => setImmediate(resolve));

    // Of the 100 calls, collect results that have already settled (the rejected ones)
    // and verify the cap was never exceeded.
    const settled = await Promise.all(
      calls.map(p =>
        Promise.race([
          p.then(r => r),
          new Promise<null>(res => setTimeout(() => res(null), 10)),
        ]),
      ),
    );

    // Count how many were rejected (success: false with concurrent cap message)
    const rejected = settled.filter(
      r => r !== null && r.success === false && /too many concurrent/i.test(r.output ?? ''),
    );

    // At most MAX_CONCURRENT_SPAWNS (20) should have gotten through
    const accepted = settled.filter(r => r === null || r?.success === true);

    expect(rejected.length).toBeGreaterThanOrEqual(80);  // at least 80 of 100 blocked
    expect(accepted.length).toBeLessThanOrEqual(20);     // at most 20 got through
    expect(peakConcurrent).toBeLessThanOrEqual(20);      // peak never exceeded cap
  });
});

describe('sessions.spawn — env var overrides', () => {
  it('respects SUDO_MAX_SPAWN_DEPTH env var override', async () => {
    vi.resetModules();
    process.env['SUDO_MAX_SPAWN_DEPTH'] = '1';
    try {
      const { sessionsSpawnTool: tool, _resetBudgetState: reset } =
        await import('../../../src/core/tools/builtin/meta/sessions-spawn.js');
      const { injectMetaToolDeps: inject } =
        await import('../../../src/core/tools/builtin/meta/index.js');
      reset();
      let c = 0;
      inject({
        agentLoop: { run: vi.fn(async () => ({ text: 'ok' })) },
        sessionManager: { getOrCreate: vi.fn(async () => ({ id: `env-${++c}` })) },
      });
      const root = makeToolContext({ sessionId: 'env-root' });
      const r1 = await tool.execute({ task: 'env-task-1', announceBack: false }, root);
      expect(r1.success).toBe(true);
      // Depth 1 session tries to spawn: should be rejected since max is 1
      const childId = (r1.data as Record<string, unknown>)['sessionId'] as string;
      const r2 = await tool.execute({ task: 'env-task-2', announceBack: false }, makeToolContext({ sessionId: childId }));
      expect(r2.success).toBe(false);
      expect(r2.output).toMatch(/depth limit reached/i);
    } finally {
      delete process.env['SUDO_MAX_SPAWN_DEPTH'];
      vi.resetModules();
    }
  });
});
