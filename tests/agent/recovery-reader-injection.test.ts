/**
 * @file recovery-reader-injection.test.ts
 * @description Recovery reader (Track 1, PR2) — closes the READ side of the
 * learning loop. On a tool FAILURE, executeToolCalls consults a
 * `preventionLookup` (sourced from ToolOutcomeLearner.checkPreventionRulesForError
 * under SUDO_FAILURE_PREVENTION_HINT=1) and prepends any prior-recovery hint to
 * the tool message the model sees on its next turn.
 *
 * Mirrors the proven slice-4 criticFeedback carrier mechanics
 * (verify-gate-integration.test.ts): the lookup runs only on failure, the live
 * tool-result event stays un-prefixed, and the path fails open.
 *
 * RDR-5 is the closed-loop test: it drives PR1's producer (fail→success records
 * a rule) and then PR2's reader (a later same-tool+error failure surfaces it)
 * through the REAL failure-learner module — proving both halves connect.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  executeToolCalls,
  type ToolRegistryLike,
  type SessionLike,
  type HookEmitterLike,
  type PreventionLookupLike,
} from '../../src/core/agent/loop-helpers.js';
import { PermissionManager } from '../../src/core/agent/permissions.js';
import { ToolOutcomeLearner } from '../../src/core/agent/tool-outcome-learner.js';
import type { AgentState } from '../../src/core/agent/types.js';

type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `tc-${Math.random().toString(36).slice(2, 9)}`, name, arguments: args };
}

function makeState(): AgentState {
  return {
    sessionId: 'test-session',
    isCompacting: false,
    pendingToolCalls: 0,
    iterationCount: 0,
    maxIterations: 50,
    consecutiveReplans: 0,
  } as AgentState;
}

function makeSession(): SessionLike {
  return { id: 'test-session', messages: [] };
}

function makeHooks(): HookEmitterLike {
  return { emit: async () => undefined };
}

/** Registry whose tool reports failure via the authoritative success flag. */
function softFailRegistry(output: string): ToolRegistryLike {
  return {
    execute: vi.fn(async () => ({ success: false, output })),
    getSchemaForLLM: vi.fn(() => []),
  };
}

/** Registry whose tool throws (the catch path). */
function throwingRegistry(message: string): ToolRegistryLike {
  return {
    execute: vi.fn(async () => { throw new Error(message); }),
    getSchemaForLLM: vi.fn(() => []),
  };
}

/** Registry whose tool succeeds. */
function okRegistry(): ToolRegistryLike {
  return {
    execute: vi.fn(async (name: string) => ({ success: true, output: `ok:${name}` })),
    getSchemaForLLM: vi.fn(() => []),
  };
}

// executeToolCalls positional tail: …, groundingChecker, groundingBlockEnabled,
// criticPass, preventionLookup. Everything between hooks and the lookup is
// undefined/false for these tests.
async function run(
  calls: ToolCall[],
  session: SessionLike,
  registry: ToolRegistryLike,
  lookup?: PreventionLookupLike,
): Promise<void> {
  await executeToolCalls(
    calls, session, makeState(), () => undefined,
    registry, undefined, undefined, makeHooks(), undefined, undefined,
    undefined, undefined, false, undefined,
    lookup,
  );
}

describe('recovery reader — prevention hint injection on tool failure', () => {
  // PermissionManager is a process-wide singleton — reset so a stray override
  // from another test can't short-circuit Phase-0 before our path runs.
  beforeEach(() => {
    PermissionManager.getInstance().resetAll();
  });

  it('RDR-1: failed tool + lookup hit → hint prepended, lookup called with (tool, error)', async () => {
    const session = makeSession();
    const lookup = vi.fn((_t: string, _e: string) => 'Prevention rule: set timeout >= 30s') as PreventionLookupLike;
    await run([call('web.fetch', { url: 'x' })], session, softFailRegistry('ETIMEDOUT connecting to host'), lookup);

    expect(lookup).toHaveBeenCalledWith('web.fetch', 'ETIMEDOUT connecting to host');
    const stored = String(session.messages[0]?.content ?? '');
    // Order: hint line, blank line, raw tool output.
    expect(stored).toBe('Prevention rule: set timeout >= 30s\n\nETIMEDOUT connecting to host');
  });

  it('RDR-2: successful tool → lookup never consulted, no hint', async () => {
    const session = makeSession();
    const lookup = vi.fn(() => 'should not appear') as unknown as PreventionLookupLike;
    await run([call('web.fetch', { url: 'x' })], session, okRegistry(), lookup);

    expect(lookup).not.toHaveBeenCalled();
    expect(String(session.messages[0]?.content ?? '')).toBe('ok:web.fetch');
  });

  it('RDR-3: no lookup wired (flag off) → message unchanged', async () => {
    const session = makeSession();
    await run([call('web.fetch', { url: 'x' })], session, softFailRegistry('ECONNRESET'), undefined);
    expect(String(session.messages[0]?.content ?? '')).toBe('ECONNRESET');
  });

  it('RDR-4: lookup returns null (nothing on record) → message unchanged', async () => {
    const session = makeSession();
    const lookup = vi.fn(() => null) as PreventionLookupLike;
    await run([call('web.fetch', { url: 'x' })], session, softFailRegistry('ENOTFOUND'), lookup);
    expect(lookup).toHaveBeenCalledWith('web.fetch', 'ENOTFOUND');
    expect(String(session.messages[0]?.content ?? '')).toBe('ENOTFOUND');
  });

  it('RDR-5: throwing lookup fails open — tool path does not throw, raw error preserved', async () => {
    const session = makeSession();
    const lookup = (() => { throw new Error('db gone'); }) as PreventionLookupLike;
    await expect(
      run([call('web.fetch', { url: 'x' })], session, softFailRegistry('ETIMEDOUT'), lookup),
    ).resolves.toBeUndefined();
    expect(String(session.messages[0]?.content ?? '')).toBe('ETIMEDOUT');
  });

  it('RDR-6: thrown-tool (catch path) also triggers the lookup with the error string', async () => {
    const session = makeSession();
    const seen: Array<[string, string]> = [];
    const lookup = ((t: string, e: string) => { seen.push([t, e]); return 'Prevention rule: check the path'; }) as PreventionLookupLike;
    await run([call('fs.read', { path: '/nope' })], session, throwingRegistry('boom'), lookup);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe('fs.read');
    expect(seen[0]?.[1]).toContain('Error executing tool fs.read');
    expect(String(session.messages[0]?.content ?? '')).toMatch(/^Prevention rule: check the path\n\n/);
  });

  it('RDR-7: CLOSED LOOP — PR1 producer records a rule, PR2 reader injects it on the next same-tool failure', async () => {
    // Fresh failure-learner module so the in-memory store is isolated.
    vi.resetModules();
    const fl = await import('../../src/core/learning/failure-learner.js');
    const learner = new ToolOutcomeLearner({ failureLearner: fl });
    const err = 'ETIMEDOUT connecting to host';

    // PR1: same-session fail→success records a solution + prevention rule.
    learner.onToolResult('web.fetch', { url: 'a' }, false, err, 's-1');
    learner.onToolResult('web.fetch', { url: 'b' }, true, undefined, 's-1');
    expect(fl.getPreventionRule('web.fetch', err)).toBeDefined();

    // PR2: a NEW failure with the same tool+error surfaces the recorded rule.
    const session = makeSession();
    const lookup: PreventionLookupLike = (t, e) => learner.checkPreventionRulesForError(t, e);
    await run([call('web.fetch', { url: 'c' })], session, softFailRegistry(err), lookup);

    const stored = String(session.messages[0]?.content ?? '');
    expect(stored).toContain('Prevention rule:');
    expect(stored.endsWith(err)).toBe(true); // raw tool output still present below the hint
  });

  it('RDR-8: the tool-result event carries the real call args on success (feeds the learner)', async () => {
    const session = makeSession();
    const events: Array<{ type: string; args?: Record<string, unknown> }> = [];
    await executeToolCalls(
      [call('fs.read', { path: '/good.txt', mode: 'utf8' })], session, makeState(),
      (ev) => events.push(ev as { type: string; args?: Record<string, unknown> }),
      okRegistry(), undefined, undefined, makeHooks(), undefined, undefined,
      undefined, undefined, false, undefined, undefined,
    );
    const tr = events.find((e) => e.type === 'tool-result');
    // Previously this was hardcoded {} at the loop's onToolResult call site —
    // now the event carries the actual args so the recovery rule is meaningful.
    expect(tr?.args).toEqual({ path: '/good.txt', mode: 'utf8' });
  });

  it('RDR-9: the tool-result event carries args on failure too', async () => {
    const session = makeSession();
    const events: Array<{ type: string; args?: Record<string, unknown>; success?: boolean }> = [];
    await executeToolCalls(
      [call('web.fetch', { url: 'http://x' })], session, makeState(),
      (ev) => events.push(ev as { type: string; args?: Record<string, unknown>; success?: boolean }),
      softFailRegistry('ETIMEDOUT'), undefined, undefined, makeHooks(), undefined, undefined,
      undefined, undefined, false, undefined, undefined,
    );
    const tr = events.find((e) => e.type === 'tool-result');
    expect(tr?.success).toBe(false);
    expect(tr?.args).toEqual({ url: 'http://x' });
  });
});
