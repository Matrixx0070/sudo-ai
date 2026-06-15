/**
 * @file verify-gate-integration.test.ts
 * Integration test for `executeToolCalls` exercising the verify-gate pipeline.
 *
 * Closes slice 1's MED-2 carryover (an integration test for the escalate hook
 * path) and pins slice 2's grounding-check semantics end-to-end.
 *
 * Branches covered:
 *
 *   VGI-01 destructive tool, gate allows           → tool executes, no gate hooks
 *   VGI-02 destructive tool, gate escalates,       → tool executes,
 *          grounding ok                              `verify_gate_escalated` emitted,
 *                                                    no `verify_gate_grounding_failed`
 *   VGI-03 destructive tool, gate escalates,       → tool executes (observable),
 *          grounding fails, block disabled           both hook events emitted,
 *                                                    `blocked: false` on grounding event
 *   VGI-04 destructive tool, gate escalates,       → tool BLOCKED (registry.execute
 *          grounding fails, block enabled            never called), structured
 *                                                    `[VerifyGate] Tool call blocked` msg,
 *                                                    `blocked: true` on grounding event
 *   VGI-05 grounding checker throws                → fail-open: tool executes,
 *                                                    no `verify_gate_grounding_failed`
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeToolCalls,
  type ToolRegistryLike,
  type SessionLike,
  type VerifyGateLike,
  type GroundingCheckerLike,
  type CriticPassLike,
  type HookEmitterLike,
} from '../../src/core/agent/loop-helpers.js';
import { PermissionManager } from '../../src/core/agent/permissions.js';
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

function makeRegistry(): { registry: ToolRegistryLike; executed: () => string[] } {
  const calls: string[] = [];
  const registry: ToolRegistryLike = {
    execute: vi.fn(async (name: string) => {
      calls.push(name);
      return { success: true, output: `ok:${name}` };
    }),
    getSchemaForLLM: vi.fn(() => []),
  };
  return { registry, executed: () => calls };
}

function makeHooks(): { hooks: HookEmitterLike; events: Array<{ event: string; ctx: Record<string, unknown> }> } {
  const events: Array<{ event: string; ctx: Record<string, unknown> }> = [];
  const hooks: HookEmitterLike = {
    emit: async (event: string, ctx: Record<string, unknown>) => {
      events.push({ event, ctx });
    },
  };
  return { hooks, events };
}

function escalatingGate(toolName: string): VerifyGateLike {
  return {
    evaluate: (name: string) =>
      name === toolName
        ? { decision: 'escalate', confidence: 0.2, threshold: 0.55, samples: 20, reason: 'below-threshold' }
        : { decision: 'allow', confidence: null, threshold: 0.55, samples: 0, reason: 'readonly' },
  };
}

function allowingGate(): VerifyGateLike {
  return {
    evaluate: () => ({ decision: 'allow', confidence: null, threshold: 0.55, samples: 0, reason: 'readonly' }),
  };
}

function fixedGrounding(ok: boolean, reason = ok ? 'edit-grounding-ok' : 'edit-grounding-fail'): GroundingCheckerLike {
  return {
    check: async () => ({
      ok,
      reason,
      checked: 'edit-grounding',
      evidence: { filePath: '/tmp/x.txt', oldStringLen: 10 },
    }),
  };
}

async function drainMicrotasks(): Promise<void> {
  // safeEmit is fire-and-forget. Drain a full macrotask turn so hook
  // assertions remain stable even if safeEmit grows internal awaits.
  await new Promise((r) => setTimeout(r, 0));
}

describe('executeToolCalls — verify-gate slice 1 + slice 2 integration', () => {
  // Guard against permission-override pollution from any other test in the
  // suite — PermissionManager is a process-wide singleton. Without this,
  // a stray `deny` override on coder.write-file would cause Phase-0 in
  // executeToolCalls to short-circuit BEFORE the gate code runs, silently
  // false-passing every assertion below.
  beforeEach(() => {
    PermissionManager.getInstance().resetAll();
  });
  it('VGI-01 allow decision → tool executes, no gate hooks', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', content: 'hello' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      allowingGate(),
      fixedGrounding(false), // would fire if gate didn't allow
      true,                  // block enabled — proves it's gate-gated
    );

    expect(executed()).toEqual(['coder.write-file']);
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_escalated')).toBeUndefined();
    expect(events.find((e) => e.event === 'verify_gate_grounding_failed')).toBeUndefined();
  });

  it('VGI-02 escalate + grounding ok → tool runs, escalate hook only', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'foo' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(true),
      true, // block enabled — doesn't matter, grounding ok
    );

    expect(executed()).toEqual(['coder.write-file']);
    await drainMicrotasks();
    const escalated = events.find((e) => e.event === 'verify_gate_escalated');
    expect(escalated).toBeDefined();
    expect(escalated?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      confidence: 0.2,
      threshold: 0.55,
      samples: 20,
      reason: 'below-threshold',
    });
    expect(events.find((e) => e.event === 'verify_gate_grounding_failed')).toBeUndefined();
  });

  it('VGI-03 escalate + grounding fail, block disabled → tool still runs, both hooks emitted', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const session = makeSession();
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, session, makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false, // observable-only
    );

    expect(executed()).toEqual(['coder.write-file']);
    // Positive-shape assertion: message is the tool result (not a permission/
    // security/verify-gate block message) — catches a false-pass if the
    // singleton-state guard above ever regresses.
    expect(session.messages[0]?.role).toBe('tool');
    expect(session.messages[0]?.content).toBe('ok:coder.write-file');
    expect(String(session.messages[0]?.content)).not.toMatch(/^\[(PermissionManager|SecurityGuard|VerifyGate)\]/);
    await drainMicrotasks();
    const escalated = events.find((e) => e.event === 'verify_gate_escalated');
    const groundingFailed = events.find((e) => e.event === 'verify_gate_grounding_failed');
    expect(escalated).toBeDefined();
    expect(groundingFailed).toBeDefined();
    expect(groundingFailed?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      reason: 'edit-grounding-fail',
      checked: 'edit-grounding',
      blocked: false,
      // Slice-3 ergonomics: confidence/threshold carried alongside grounding
      // result so a critic consumer doesn't have to correlate two hook events.
      confidence: 0.2,
      threshold: 0.55,
    });
  });

  it('VGI-04 escalate + grounding fail, block enabled → tool BLOCKED, registry.execute never called', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const session = makeSession();
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, session, makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      true, // BLOCK
    );

    expect(executed()).toEqual([]); // tool was not executed
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.role).toBe('tool');
    expect(String(session.messages[0]?.content)).toMatch(/^\[VerifyGate\] Tool call blocked: coder\.write-file/);
    expect(String(session.messages[0]?.content)).toMatch(/edit-grounding-fail/);

    await drainMicrotasks();
    const escalated = events.find((e) => e.event === 'verify_gate_escalated');
    const groundingFailed = events.find((e) => e.event === 'verify_gate_grounding_failed');
    expect(escalated).toBeDefined();
    expect(groundingFailed?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      reason: 'edit-grounding-fail',
      blocked: true,
    });
  });

  // Slice 3 — auto-critic. The critic verdict ships out as a hook event but
  // never blocks tool execution in slice 3 (observable-only).

  function recordingCritic(
    review: CriticPassLike['review'],
  ): { critic: CriticPassLike; reviews: Array<Parameters<CriticPassLike['review']>[0]> } {
    const reviews: Array<Parameters<CriticPassLike['review']>[0]> = [];
    const critic: CriticPassLike = {
      review: async (input) => {
        reviews.push(input);
        return review(input);
      },
    };
    return { critic, reviews };
  }

  it('VGI-06 escalate + grounding fail observable → critic invoked with grounding-failed trigger', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const { critic, reviews } = recordingCritic(async () => ({
      invoked: true,
      verdict: 'reject',
      reason: 'invoked',
      rationale: 'old_string not present in file',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false, // observable-only
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']); // critic is observable-only
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      toolName: 'coder.write-file',
      trigger: 'grounding-failed',
      confidence: 0.2,
      threshold: 0.55,
    });
    expect(reviews[0]?.evidence).toMatchObject({ reason: 'edit-grounding-fail' });

    await drainMicrotasks();
    const invoked = events.find((e) => e.event === 'verify_gate_critic_invoked');
    expect(invoked).toBeDefined();
    expect(invoked?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      trigger: 'grounding-failed',
      verdict: 'reject',
      rationale: 'old_string not present in file',
    });
  });

  it('VGI-07 escalate + grounding ok → critic gets low-confidence trigger, skipped hook event', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const { critic, reviews } = recordingCritic(async () => ({
      invoked: false,
      verdict: 'skip',
      reason: 'soft-skip',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'foo' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(true),
      true, // block enabled — doesn't matter, grounding ok
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.trigger).toBe('low-confidence');
    // No grounding evidence on the soft path.
    expect(reviews[0]?.evidence).toBeUndefined();

    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_critic_invoked')).toBeUndefined();
    const skipped = events.find((e) => e.event === 'verify_gate_critic_skipped');
    expect(skipped).toBeDefined();
    expect(skipped?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      trigger: 'low-confidence',
      reason: 'soft-skip',
    });
  });

  it('VGI-08 escalate + grounding fail, block enabled → critic never invoked (already blocked)', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const { critic, reviews } = recordingCritic(async () => ({
      invoked: true,
      verdict: 'approve',
      reason: 'invoked',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      true, // BLOCK — short-circuits before the critic
      critic,
    );

    expect(executed()).toEqual([]);
    expect(reviews).toHaveLength(0);
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_critic_invoked')).toBeUndefined();
    expect(events.find((e) => e.event === 'verify_gate_critic_skipped')).toBeUndefined();
  });

  it('VGI-09 critic returns budget-exhausted → dedicated hook event, no invoked event', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const { critic } = recordingCritic(async () => ({
      invoked: false,
      verdict: 'skip',
      reason: 'budget-exhausted',
      rationale: 'errors=2/3',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false,
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']);
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_critic_invoked')).toBeUndefined();
    const budget = events.find((e) => e.event === 'verify_gate_critic_budget_exhausted');
    expect(budget).toBeDefined();
    expect(budget?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      trigger: 'grounding-failed',
      reason: 'budget-exhausted',
      // MED-2: rationale carries errors=K/N so ops can distinguish
      // "flaky provider burned the budget" from "real reviews burned it".
      rationale: 'errors=2/3',
    });
  });

  it('VGI-12 grounding checker throws + critic wired → soft low-confidence trigger', async () => {
    // LOW-1 coverage: VGI-05 covered the throw path before slice 3 existed and
    // did not assert critic behavior. Here we pin: when grounding threw and
    // groundingFailedObservable stays false, the critic gets the SOFT trigger
    // ('low-confidence') and immediately short-circuits — no LLM call.
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const { critic, reviews } = recordingCritic(async () => ({
      invoked: false,
      verdict: 'skip',
      reason: 'soft-skip',
    }));
    const throwing: GroundingCheckerLike = {
      check: async () => { throw new Error('disk on fire'); },
    };
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'foo' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      throwing,
      false,
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.trigger).toBe('low-confidence');
    expect(reviews[0]?.evidence).toBeUndefined();
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_grounding_error')).toBeDefined();
    const skipped = events.find((e) => e.event === 'verify_gate_critic_skipped');
    expect(skipped).toBeDefined();
    expect(skipped?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      trigger: 'low-confidence',
      reason: 'soft-skip',
    });
  });

  it('VGI-10 critic.review throws → fail-open, dedicated error event, tool still runs', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const critic: CriticPassLike = {
      review: async () => { throw new Error('critic on fire'); },
    };
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'absent' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      fixedGrounding(false),
      false,
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']);
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_critic_invoked')).toBeUndefined();
    const erred = events.find((e) => e.event === 'verify_gate_critic_error');
    expect(erred).toBeDefined();
    expect(erred?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      trigger: 'grounding-failed',
      err: expect.stringContaining('critic on fire'),
    });
  });

  it('VGI-11 gate allow → critic never consulted (no escalation, nothing to critique)', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const { critic, reviews } = recordingCritic(async () => ({
      invoked: true,
      verdict: 'reject',
      reason: 'invoked',
    }));
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', content: 'hello' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      allowingGate(),
      fixedGrounding(false),
      true,
      critic,
    );

    expect(executed()).toEqual(['coder.write-file']);
    expect(reviews).toHaveLength(0);
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_critic_invoked')).toBeUndefined();
    expect(events.find((e) => e.event === 'verify_gate_critic_skipped')).toBeUndefined();
  });

  it('VGI-05 grounding checker throws → fail-open, tool runs, no grounding_failed event', async () => {
    const { registry, executed } = makeRegistry();
    const { hooks, events } = makeHooks();
    const throwing: GroundingCheckerLike = {
      check: async () => { throw new Error('disk on fire'); },
    };
    const calls = [call('coder.write-file', { file_path: '/tmp/x.txt', old_string: 'foo' })];

    await executeToolCalls(
      calls, makeSession(), makeState(), () => undefined,
      registry, undefined, undefined, hooks, undefined, undefined,
      escalatingGate('coder.write-file'),
      throwing,
      true, // block enabled — should still NOT block since grounding threw
    );

    expect(executed()).toEqual(['coder.write-file']);
    await drainMicrotasks();
    expect(events.find((e) => e.event === 'verify_gate_escalated')).toBeDefined();
    expect(events.find((e) => e.event === 'verify_gate_grounding_failed')).toBeUndefined();
    // MED-3: distinguish "checker threw" from "no checker wired" — the
    // throw path emits a dedicated verify_gate_grounding_error event so
    // ops dashboards and slice-3 critics don't read a silent pass-through.
    const erred = events.find((e) => e.event === 'verify_gate_grounding_error');
    expect(erred).toBeDefined();
    expect(erred?.ctx).toMatchObject({
      toolName: 'coder.write-file',
      err: expect.stringContaining('disk on fire'),
    });
  });
});
