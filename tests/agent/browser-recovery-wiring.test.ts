/**
 * @file browser-recovery-wiring.test.ts
 * @description Integration: drive failing browser.click calls through the REAL
 * executeToolCalls and prove the recovery hint reaches the stored tool message.
 * No real browser — the augment path (needs a live snapshot) yields no hint here,
 * so we assert the escalation path fires on the 3rd consecutive failure.
 */
import { describe, it, expect } from 'vitest';
import { executeToolCalls } from '../../src/core/agent/loop-helpers.js';
import type { ToolRegistryLike, SessionLike } from '../../src/core/agent/loop-helpers.js';
import type { AgentState } from '../../src/core/agent/types.js';
import { resetBrowserRecovery } from '../../src/core/agent/browser-recovery.js';

const SID = 'recovery-wiring-session';

function makeState(): AgentState {
  return {
    sessionId: SID,
    isCompacting: false,
    pendingToolCalls: 0,
    iterationCount: 0,
    maxIterations: 50,
    consecutiveReplans: 0,
  } as AgentState;
}

// Registry whose browser.click always fails via the authoritative success flag.
const failingRegistry = {
  execute: async (_name: string, _args: Record<string, unknown>, _ctx: unknown) => ({
    success: false,
    output: 'boom: element not found',
  }),
} as unknown as ToolRegistryLike;

let idSeq = 0;
const clickCall = () => ({ id: `tc-${++idSeq}`, name: 'browser.click', arguments: { ref: 5 } });

describe('browser recovery wired into executeToolCalls', () => {
  it('escalates on the 3rd consecutive browser.click failure (stored message)', async () => {
    resetBrowserRecovery(SID);
    const session: SessionLike = { id: SID, messages: [] };

    // Three failing browser.click calls in the same session.
    for (let i = 0; i < 3; i++) {
      await executeToolCalls([clickCall()], session, makeState(), () => undefined, failingRegistry);
    }

    const contents = session.messages.map((m) => String(m.content));
    expect(contents).toHaveLength(3);

    // Failures 1-2: no real browser → no fresh snapshot → raw output only.
    expect(contents[0]).toContain('boom');
    expect(contents[0]).not.toContain('BROWSER RECOVERY');

    // Failure 3: escalation hint appended (no snapshot needed for escalation).
    expect(contents[2]).toContain('[BROWSER RECOVERY]');
    expect(contents[2]).toContain('operator notified');
    expect(contents[2]).toMatch(/Stop repeating/i);
    // Raw output is preserved alongside the hint.
    expect(contents[2]).toContain('boom');
  });

  it('kill-switch SUDO_BROWSER_RECOVERY=0 suppresses the hint', async () => {
    resetBrowserRecovery(SID);
    const prev = process.env['SUDO_BROWSER_RECOVERY'];
    process.env['SUDO_BROWSER_RECOVERY'] = '0';
    try {
      const session: SessionLike = { id: SID, messages: [] };
      for (let i = 0; i < 3; i++) {
        await executeToolCalls([clickCall()], session, makeState(), () => undefined, failingRegistry);
      }
      expect(session.messages.every((m) => !String(m.content).includes('BROWSER RECOVERY'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['SUDO_BROWSER_RECOVERY'];
      else process.env['SUDO_BROWSER_RECOVERY'] = prev;
    }
  });
});
